# Batched Run Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute flow steps in 1,000-row target batches and show safe live execution progress in the Run dashboard without changing cancellation, preview, or transaction semantics.

**Architecture:** `MigrationRunner` will split only already-prepared target rows and report count-only progress after each successful chunk. A fixed typed Electron event carries that transient progress to the renderer which owns subscription lifecycle and renders an accessible native progress bar. The existing step-level commit boundaries remain unchanged.

**Tech Stack:** Electron IPC with context isolation, TypeScript, React, Vitest, Testing Library, node-oracledb `executeMany`.

**Spec:** `docs/superpowers/specs/2026-08-25-batched-run-progress-design.md`

## Global Constraints

- Batch size is exactly 1,000 rows; do not add a setting or configuration surface.
- Source queries and preview rendering remain whole-result operations; do not stream, paginate, or virtualize them in this work.
- Progress payloads contain only run ID, step index, and count fields; never include SQL, source rows, bind values, credentials, or errors.
- Progress is in-memory and renderer-local only. Do not write it to SQLite, history DTOs, run events, or logs.
- `all_or_nothing` commits once after all chunks/steps succeed and rolls all chunks back on failure.
- `commit_successes` commits once after all chunks for a step succeed and rolls that entire step back on failure.
- Preserve current recovery actions, trusted-sender checks, generic-SQL prohibition, and context isolation.
- Do not create commits: this workspace contains unrelated user changes. Verify only the files changed for this feature.

---

## File Structure

- `electron/application/migrationRunner.ts`: owns batch splitting and application-level count-only progress reporting.
- `electron/application/migrationRunner.test.ts`: proves batch boundaries, transaction behavior, progress sequence, failure, and retry behavior.
- `electron/ipc/commands.ts`: declares the private fixed progress channel, DTO, and preload API contract.
- `electron/ipc/handlers.ts`: projects application progress to a trusted initiating renderer.
- `electron/ipc/handlers.test.ts`, `electron/preload.ts`, `electron/preload.test.ts`, and `electron/ipc/architecture.test.ts`: validate the narrow event boundary and safe payload.
- `src/types/electron-api.d.ts`, `src/test/setup.ts`, `src/lib/desktop.ts`: provide the renderer-safe typed subscription surface and test double.
- `src/features/run/run.api.tsx`, `RunDashboard.tsx`, `RunDashboard.test.tsx`, and `src/styles/global.css`: subscribe during active execution and render/clean up live progress.

### Task 1: Batch Target Execution in MigrationRunner

**Files:**
- Modify: `electron/application/migrationRunner.ts:18-35, 181-559, 729-762`
- Test: `electron/application/migrationRunner.test.ts:1-780, 843-950`

**Interfaces:**
- Produces `RunProgress` and `RunProgressReporter` exported from `migrationRunner.ts`:

```ts
export type RunProgress = {
  runId: string;
  step: number;
  processedRows: number;
  totalRows: number;
  completedBatches: number;
  totalBatches: number;
};
export type RunProgressReporter = (progress: RunProgress) => void;
```

- Extends `startRun(flowId, onProgress?)` and `recoverRun(request, onProgress?)` without changing their terminal `RunDto` result.
- Consumed by Task 2's IPC handler; no `RunDto`, history state, or repository interface changes.

- [ ] **Step 1: Write failing all-or-nothing batching/progress tests**

Add a row-set helper that returns 2,001 rows and record each `rows.length` argument passed to the target fake. Add this test before production code:

```ts
it("executes a 2,001-row all-or-nothing step in 1,000-row chunks and reports progress", async () => {
  const progress: RunProgress[] = [];
  const test = harness("all_or_nothing").sourceRowsAt(0, numberedRowSet("ID", 2_001));

  await test.runner.startRun(test.flowId, (update) => progress.push(update));

  expect(test.connector.executedRowCounts).toEqual([1_000, 1_000, 1, 1]);
  expect(progress.filter((update) => update.step === 0)).toEqual([
    { runId: expect.any(String), step: 0, processedRows: 1_000, totalRows: 2_001, completedBatches: 1, totalBatches: 3 },
    { runId: expect.any(String), step: 0, processedRows: 2_000, totalRows: 2_001, completedBatches: 2, totalBatches: 3 },
    { runId: expect.any(String), step: 0, processedRows: 2_001, totalRows: 2_001, completedBatches: 3, totalBatches: 3 },
  ]);
  expect(test.connector.targetTransactions()).toContain("commit");
});
```

The fourth recorded execution is the existing second flow step; assert its length separately so the test proves no rows are lost.

- [ ] **Step 2: Run the new test to verify RED**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: FAIL because `startRun` does not accept a progress reporter and the target fake has no `executedRowCounts` recording or 1,000-row chunk calls.

- [ ] **Step 3: Implement the minimal batch executor**

Add `const RUN_BATCH_SIZE = 1_000` and a private method that slices a validated step batch, calls `target.executeNamed`, totals the returned affected rows, and reports only after success:

```ts
private async executeStepBatches(
  runId: string, step: number, sql: string, rows: readonly NamedRow[],
  target: DatabaseSession, report?: RunProgressReporter,
): Promise<number> {
  const totalBatches = Math.ceil(rows.length / RUN_BATCH_SIZE);
  let processedRows = 0;
  let affectedRows = 0;
  for (let offset = 0; offset < rows.length; offset += RUN_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + RUN_BATCH_SIZE);
    affectedRows += await target.executeNamed(sql, chunk);
    processedRows += chunk.length;
    report?.({ runId, step, processedRows, totalRows: rows.length,
      completedBatches: Math.ceil(processedRows / RUN_BATCH_SIZE), totalBatches });
  }
  return affectedRows;
}
```

Thread `report` through `startRun`, `recoverRun`, `executeAllOrNothing`, `executeCommittedSteps`, `skipAndContinue`, and `editAndRetry`. Replace their flow-step `executeNamed` calls with this executor. Do not apply it to `runFlowStep`, which is explicitly out of scope. Preserve empty-row behavior: it performs no target call and sends no progress event.

- [ ] **Step 4: Run the runner test file to verify GREEN**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: PASS, including the new batching/progress test and all pre-existing recovery tests.

- [ ] **Step 5: Add RED tests for rollback and recovery semantics**

Add two focused tests:

```ts
it("rolls back all executed chunks when all-or-nothing fails in batch three", async () => {
  const test = harness("all_or_nothing")
    .sourceRowsAt(0, numberedRowSet("ID", 3_000))
    .targetFailsAt(2);
  const result = await test.runner.startRun(test.flowId);
  expect(result.status).toBe("rolled_back");
  expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "execute:1", "execute:2", "rollback"]);
});

it("rolls back the whole failed committed step and batches its edit-and-retry", async () => {
  const test = harness("commit_successes")
    .sourceRowsAt(0, numberedRowSet("ID", 3_000))
    .targetFailsAt(2);
  const paused = await test.runner.startRun(test.flowId);
  test.connector.clearTargetFailures();
  const result = await test.runner.recoverRun(editRequest(paused.runId));
  expect(result.steps[0]).toEqual({ succeeded: { affected_rows: 3_000 } });
});
```

Update the recording connector only as needed to reset a configured failure without inspecting or retaining row values.

- [ ] **Step 6: Run the runner test file to verify RED**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: the tests initially fail until chunk calls replace each single flow-step target call. If Step 3 already made them pass, first make the assertions precise around the current behavior that is still missing (failure-to-progress exclusion or recovery callback propagation) and observe that expected failure before completing the implementation.

- [ ] **Step 7: Complete recovery propagation and verify GREEN**

Ensure failed chunks do not emit an event, successful preceding chunks do, and retry begins with a fresh `processedRows` value for that retrying step. Run:

`pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: PASS with the original 70 tests plus all new boundary, failure, and retry cases.

### Task 2: Expose a Fixed, Safe Progress Event Across Electron IPC

**Files:**
- Modify: `electron/ipc/commands.ts:1-250`
- Modify: `electron/ipc/handlers.ts:35-215, 620-730`
- Modify: `electron/preload.ts:1-110`
- Modify: `src/types/electron-api.d.ts:1-5`
- Modify: `src/test/setup.ts:1-8`
- Modify: `src/lib/desktop.ts:1-120`
- Test: `electron/ipc/handlers.test.ts`, `electron/preload.test.ts`, `electron/ipc/architecture.test.ts`, `src/lib/desktop.test.ts`

**Interfaces:**
- Consumes Task 1's `RunProgress`.
- Produces a fixed `DB_RELAY_RUN_PROGRESS_CHANNEL` and a preload-only `DbRelayApi.subscribeRunProgress(listener): () => void`.
- Does not add a `DbRelayCommand`, arbitrary IPC channel, generic event listener, SQL payload, or history DTO field.

- [ ] **Step 1: Write failing boundary tests**

Add tests that require a complete count-only payload, reject extra/sensitive keys, and prove subscription cleanup:

```ts
it("projects run progress with counts only", async () => {
  const emitted: unknown[] = [];
  const handler = createDbRelayCommandHandler(services, (progress) => emitted.push(progress));
  await handler("start_run", { request: { flowId: "flow-1" } });
  expect(emitted[0]).toEqual({ runId: expect.any(String), step: 0,
    processedRows: 1_000, totalRows: 2_001, completedBatches: 1, totalBatches: 3 });
  expect(JSON.stringify(emitted)).not.toMatch(/rows|binds|sql|password|secret|credential/iu);
});

it("removes the fixed progress listener on unsubscribe", () => {
  const removeListener = vi.fn();
  const unsubscribe = subscribeRunProgress(ipcRenderer, vi.fn());
  unsubscribe();
  expect(removeListener).toHaveBeenCalledWith(DB_RELAY_RUN_PROGRESS_CHANNEL, expect.any(Function));
});
```

Update test doubles to model `ipcRenderer.on` and `ipcRenderer.removeListener`; do not use production Electron objects in renderer tests.

- [ ] **Step 2: Run IPC/preload tests to verify RED**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/lib/desktop.test.ts`

Expected: FAIL because no progress channel, projection, or subscription contract exists.

- [ ] **Step 3: Add the narrow typed event contract and projection**

In `commands.ts`, define the private channel constant and DTO:

```ts
export const DB_RELAY_RUN_PROGRESS_CHANNEL = "db-relay:run-progress";
export type RunProgressDto = {
  runId: string; step: number; processedRows: number; totalRows: number;
  completedBatches: number; totalBatches: number;
};
export interface DbRelayApi {
  invoke<Command extends DbRelayCommand>(...): Promise<CommandResponseMap[Command]>;
  subscribeRunProgress(listener: (progress: RunProgressDto) => void): () => void;
}
```

Pass an optional progress callback into `createDbRelayCommandHandler`. In `registerDbRelayIpc`, build that callback per trusted incoming IPC event and call only `event.sender.send(DB_RELAY_RUN_PROGRESS_CHANNEL, projectRunProgress(progress))`. Validate all six numeric fields as non-negative safe integers, require `processedRows <= totalRows` and `completedBatches <= totalBatches`, and project only the declared fields.

In `preload.ts`, expose only `subscribeRunProgress`. Register one listener for the fixed channel, validate the DTO before calling the renderer listener, and return an unsubscribe closure that removes exactly that listener. Extend `src/types/electron-api.d.ts`, `src/test/setup.ts`, and `src/lib/desktop.ts` with the same typed surface. Never expose `ipcRenderer.on`, `send`, a channel argument, or raw Electron event data.

- [ ] **Step 4: Run IPC/preload tests to verify GREEN**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/lib/desktop.test.ts`

Expected: PASS. Update structural assertions to verify that the progress type excludes source rows, bind values, credentials, and SQL and that the renderer only receives the fixed subscription method.

### Task 3: Display and Clear Live Progress in the Run Dashboard

**Files:**
- Modify: `src/features/run/run.api.tsx:1-15`
- Modify: `src/features/run/RunDashboard.tsx:1-70`
- Modify: `src/styles/global.css:530-560`
- Test: `src/features/run/RunDashboard.test.tsx`

**Interfaces:**
- Consumes `RunProgressDto` and the typed preload subscription from Task 2.
- Produces a renderer-local progress section; terminal `Run` values, history, and `RunLog` stay unchanged.

- [ ] **Step 1: Write a failing dashboard progress test**

Extend the `run.api` mock with `subscribeRunProgress` that captures a listener and returns an unsubscribe spy. Keep `startRun` pending, start the dashboard, then invoke the captured listener inside `act`:

```tsx
listener({ runId: "run-active", step: 0, processedRows: 1_000,
  totalRows: 2_001, completedBatches: 1, totalBatches: 3 });

expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1000");
expect(screen.getByRole("progressbar")).toHaveAttribute("max", "2001");
expect(screen.getByText(/1,000.*2,001.*1\/3/u)).toBeVisible();
```

Resolve the pending run and assert the progress section disappears. Add an unmount test that asserts the unsubscribe function is called. Add recovery coverage that accepts only matching `runId` progress for the already-known failed run.

- [ ] **Step 2: Run the dashboard test to verify RED**

Run: `pnpm vitest run src/features/run/RunDashboard.test.tsx`

Expected: FAIL because the dashboard has no subscription, progress state, or progress bar.

- [ ] **Step 3: Implement local subscription and accessible UI**

Export `subscribeRunProgress` from `run.api.tsx`. In `RunDashboard`, subscribe in an effect and unsubscribe on unmount. Track a `progress` state and an in-flight request ref: accept start-run progress only while its own invocation is active; for recovery additionally require `progress.runId === run.runId`. Clear progress in both `finally` blocks for start/recover.

Render only while a progress value exists:

```tsx
<section className="run-progress" aria-live="polite" aria-label="실행 진행률">
  <strong>실행 중 · {progress.step + 1}단계</strong>
  <span>{progress.processedRows.toLocaleString()} / {progress.totalRows.toLocaleString()}건 처리됨 · 배치 {progress.completedBatches}/{progress.totalBatches}</span>
  <progress value={progress.processedRows} max={progress.totalRows} />
</section>
```

Style `.run-progress` as a compact card matching `.run-summary`, with a full-width progress control and no buttons. Do not render “커밋 완료” for interim progress or add cancellation controls.

- [ ] **Step 4: Run dashboard tests to verify GREEN**

Run: `pnpm vitest run src/features/run/RunDashboard.test.tsx src/features/run/RunLog.test.tsx`

Expected: PASS. Existing run duration, error localization, recovery controls, and final committed result assertions remain intact.

### Task 4: Final Boundary and Release Verification

**Files:**
- Modify only if a verification failure identifies a missing assertion: `electron/ipc/architecture.test.ts` or the feature tests above.
- Verify: `docs/superpowers/specs/2026-08-25-batched-run-progress-design.md`
- Verify: `docs/superpowers/plans/2026-08-25-batched-run-progress.md`

**Interfaces:**
- Consumes the completed Tasks 1-3 public types and behavior.
- Produces verification evidence; it introduces no product interface.

- [ ] **Step 1: Inspect the feature diff and sensitive-boundary types**

Run:

`git diff -- electron/application/migrationRunner.ts electron/ipc/commands.ts electron/ipc/handlers.ts electron/preload.ts src/lib/desktop.ts src/features/run/RunDashboard.tsx src/types/electron-api.d.ts`

Confirm that progress uses only run ID/index/count fields and that no progress field appears in `RunDto`, history DTOs, SQLite repositories, or run logs.

- [ ] **Step 2: Run focused suites and the mandatory architecture suite**

Run:

`pnpm vitest run electron/application/migrationRunner.test.ts electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/features/run/RunDashboard.test.tsx`

Expected: PASS with no test failures.

- [ ] **Step 3: Run complete project verification**

Run, in order:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

Expected: every command exits 0. If Windows locks an existing release directory, use a new timestamped `release/installer-...` output folder and the already-installed unpacked Electron distribution as the previous packaging workaround, then report the precise artifact path.

- [ ] **Step 4: Report results without committing unrelated work**

Report changed files, focused and full verification results, and the installer path if packaging succeeds. Do not run `git add`, `git commit`, reset, checkout, or remove pre-existing release outputs.
