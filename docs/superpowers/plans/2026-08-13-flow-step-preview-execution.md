# Flow Step Preview and Immediate Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Source SQL result preview and immediate execution of the current flow-editor step without exposing a generic SQL IPC command.

**Architecture:** Add non-persisting preview and single-step operations to `MigrationRunner`; surface them through two named, validated IPC commands; render preview rows only in a closeable React dialog. Immediate execution uses the unsaved step SQL and exactly one target transaction.

**Tech Stack:** Electron context-isolated IPC, TypeScript, React 19, Vitest, node-oracledb.

## Global Constraints

- No generic/arbitrary SQL IPC command.
- Only `preview_flow_step` returns all source rows. They are transient: never SQLite, logs, history, run DTOs, or state after dialog close.
- Never expose passwords, credential references, target bind values, or raw driver error text.
- Run requires distinct enabled connections, uses the live editor SQL, commits one step only, and creates no history.
- Use this exact Review text: `생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오`.
- Run `pnpm vitest run electron/ipc/architecture.test.ts` after boundary changes.

---

### Task 1: Implement preview and immediate-step operations

**Files:**
- Modify: `electron/application/migrationRunner.ts`
- Test: `electron/application/migrationRunner.test.ts`

**Interfaces:**
- `previewFlowStep({ sourceConnectionId, selectSql }): Promise<{ columns: string[]; rows: NamedRow[] }>`
- `runFlowStep({ sourceConnectionId, targetConnectionId, selectSql, upsertSql }): Promise<{ affectedRows: number }>`

- [ ] **Step 1: Write failing preview tests**

```ts
it("returns all source preview rows without creating history", async () => {
  const result = await harness.runner.previewFlowStep({ sourceConnectionId: "source", selectSql: "SELECT id FROM customers" });
  expect(result).toEqual({ columns: ["ID"], rows: [{ ID: 1 }, { ID: 2 }] });
  expect(harness.history.createdRunIds()).toEqual([]);
  expect(harness.connector.targetOperations()).toEqual([]);
});
it("rejects invalid preview Source SQL", async () => {
  await expect(harness.runner.previewFlowStep({ sourceConnectionId: "source", selectSql: "DELETE FROM customers" })).rejects.toMatchObject({ code: "STATEMENT_INVALID" });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "preview"`  
Expected: FAIL because `previewFlowStep` is absent.

- [ ] **Step 3: Implement preview minimally**

Resolve a runnable source profile and its credential, validate connector kind and `validateSourceStatement`, open only a source session, query the SQL, return all `RowSet.columns` and `RowSet.rows`, and close in `finally`. Do not open a target session, call history, validate target SQL, or map rows to binds. Preserve safe existing error codes.

- [ ] **Step 4: Verify preview tests pass**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "preview"`  
Expected: PASS.

- [ ] **Step 5: Write failing immediate-execution tests**

```ts
it("commits the unsaved current step without creating a run", async () => {
  await expect(harness.runner.runFlowStep(validImmediateStep)).resolves.toEqual({ affectedRows: 1 });
  expect(harness.connector.targetOperations()).toEqual(["begin", "execute", "commit"]);
  expect(harness.history.createdRunIds()).toEqual([]);
});
it("rolls back the current step and retains the Oracle code", async () => {
  harness.targetFailsWith(new ConnectorError("ORA-00001", "private"));
  await expect(harness.runner.runFlowStep(validImmediateStep)).rejects.toMatchObject({ code: "ORA-00001" });
  expect(harness.connector.targetOperations()).toEqual(["begin", "execute", "rollback"]);
});
```

- [ ] **Step 6: Verify the tests fail**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "current step"`  
Expected: FAIL because `runFlowStep` is absent.

- [ ] **Step 7: Implement immediate execution**

Resolve distinct runnable source/target profiles and credentials; build a temporary `QueryStep`; reuse `preflightStep` for source/target SQL policy, bind extraction, mapping, and target bind capability validation. Open both sessions, `begin`, `executeNamed`, `commit`, and return count. On any failure after `begin`, attempt rollback then rethrow the original safe error. Always close sessions; do not persist a run or recovery state.

- [ ] **Step 8: Verify application tests pass and commit**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`  
Expected: PASS.

Run: `git add electron/application/migrationRunner.ts electron/application/migrationRunner.test.ts; git commit -m "feat: preview and run the current flow step"`

### Task 2: Add typed IPC commands and boundary tests

**Files:**
- Modify: `electron/ipc/commands.ts`, `electron/ipc/handlers.ts`, `electron/ipc/handlers.test.ts`, `electron/preload.test.ts`, `electron/ipc/architecture.test.ts`, `src/lib/desktop.ts`

**Interfaces:**
- Commands: `preview_flow_step`, `run_flow_step`.
- Preview request: `{ sourceConnectionId: string; selectSql: string }`; response: `{ columns: string[]; rows: Array<Record<string, PreviewCellDto>> }`.
- Run request: `{ sourceConnectionId: string; targetConnectionId: string; selectSql: string; upsertSql: string }`; response: `{ affectedRows: number }`.
- `PreviewCellDto` is lossless and JSON-safe for domain primitives, structured Oracle dates/timestamps, and `Uint8Array` base64 bytes.

- [ ] **Step 1: Write failing command tests**

```ts
it("accepts exact preview and current-step requests", async () => {
  services.runs.previewFlowStep = vi.fn().mockResolvedValue({ columns: ["ID"], rows: [{ ID: 1 }] });
  services.runs.runFlowStep = vi.fn().mockResolvedValue({ affectedRows: 1 });
  await expect(handler("preview_flow_step", { request: { sourceConnectionId: "source", selectSql: "SELECT id FROM t" } })).resolves.toEqual({ columns: ["ID"], rows: [{ ID: 1 }] });
  await expect(handler("run_flow_step", { request: validRunFlowStepRequest() })).resolves.toEqual({ affectedRows: 1 });
  await expect(handler("preview_flow_step", { request: { sourceConnectionId: "source", selectSql: "SELECT 1", extra: true } } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
it("keeps rows exclusive to preview responses", async () => {
  expect(JSON.stringify(await handler("preview_flow_step", previewRequest()))).toContain("rows");
  expect(JSON.stringify(projectedRun)).not.toMatch(/rows|binds|password|credentialRef/u);
});
```

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run electron/preload.test.ts electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts`  
Expected: FAIL because the commands do not exist.

- [ ] **Step 3: Implement narrow command contracts**

Add exact maps and names to `commands.ts`; dispatch validated input through the two Task 1 methods; include methods in `DbRelayServices.runs`; and mirror types in `src/lib/desktop.ts`. Recursively project preview cells into the response DTO and reject unsupported values with safe `PREVIEW_VALUE_UNSUPPORTED`. Return only `affectedRows` for run. Extend preload tests and structural expected list. Preserve generic-command rejection.

- [ ] **Step 4: Add structural source-row protection and verify**

Require that only the preview response type/projection has `rows`; all run/history DTOs and projections exclude `rows`, `binds`, credentials, and SQL.

Run: `pnpm vitest run electron/preload.test.ts electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts`  
Expected: PASS.

Run: `git add electron/ipc/commands.ts electron/ipc/handlers.ts electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/lib/desktop.ts; git commit -m "feat: expose flow step preview and execution IPC"`

### Task 3: Add preview dialog and editor actions

**Files:**
- Create: `src/features/flows/StepPreviewDialog.tsx`, `src/features/flows/StepPreviewDialog.test.tsx`
- Modify: `src/features/flows/flows.api.tsx`, `src/features/flows/flows.types.tsx`, `src/features/flows/FlowEditor.tsx`, `src/features/flows/QueryStepEditor.tsx`, `src/features/flows/QueryStepEditor.test.tsx`, `src/features/flows/sqlGeneration.ts`, `src/features/flows/sqlGeneration.test.ts`, `src/styles/global.css`

**Interfaces:**
- `previewFlowStep(input)` and `runFlowStep(input)` renderer wrappers.
- `StepPreviewDialog({ preview, onClose })`, with `preview` `undefined` after close.
- `QueryStepEditor` receives `sourceConnectionId` and `targetConnectionId` from `FlowEditor`.

- [ ] **Step 1: Write failing dialog tests**

```tsx
it("shows all preview rows and clears them when closed", () => {
  const close = vi.fn();
  render(<StepPreviewDialog preview={{ columns: ["ID", "NAME"], rows: [{ ID: 1, NAME: "Ada" }, { ID: 2, NAME: "Lin" }] }} onClose={close} />);
  expect(screen.getByRole("dialog", { name: "Source SQL preview" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "Lin" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(close).toHaveBeenCalledOnce();
});
it("shows an empty result state", () => {
  render(<StepPreviewDialog preview={{ columns: ["ID"], rows: [] }} onClose={vi.fn()} />);
  expect(screen.getByText("No rows returned.")).toBeVisible();
});
```

- [ ] **Step 2: Verify dialog tests fail, then implement**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx`  
Expected: FAIL because dialog is absent.

Implement an accessible modal (`role="dialog"`, `aria-modal`, labelled heading and close button), table columns in response order, complete row rendering, no-row state, and viewport-bounded horizontal/vertical scrolling. Format null, temporal, and byte cells safely. Retain response solely in component state; close sets it to `undefined`.

- [ ] **Step 3: Verify dialog passes**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx`  
Expected: PASS.

- [ ] **Step 4: Write failing editor-control tests**

```tsx
it("places preview and Run above Korean Review copy", () => {
  render(<StatefulStepEditor initialStep={updateStep()} sourceConnectionId="source" targetConnectionId="target" />);
  const hint = screen.getByText("생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오");
  expect(screen.getByRole("button", { name: "미리보기" }).compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run" }).compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("reports success count and localized Oracle failure", async () => {
  vi.mocked(runFlowStep).mockResolvedValueOnce({ affectedRows: 3 });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("status")).toHaveTextContent("3 rows executed");
  vi.mocked(runFlowStep).mockRejectedValueOnce({ code: "ORA-00001", detail: "safe" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/ORA-00001 · 고유 제약 조건 위반/);
});
```

- [ ] **Step 5: Verify failures and implement integration**

Run: `pnpm vitest run src/features/flows/QueryStepEditor.test.tsx src/features/flows/sqlGeneration.test.ts`  
Expected: FAIL because controls/copy are absent.

Pass live IDs from `FlowEditor`, place `미리보기` and `Run` immediately before the operation hint, and disable for absent SQL/IDs, pending action, and equal IDs for Run. Preview invokes current Source SQL and opens the dialog; Run submits current Source/Target SQL, uses `role="status"` for count, and formats only `formatConnectorError(error.code, error.detail)` in `role="alert"`. Replace generated UPDATE comment and UI hint with approved Korean copy; preserve insert behavior.

- [ ] **Step 6: Verify UI and boundary tests, then commit**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx src/features/flows/QueryStepEditor.test.tsx src/features/flows/FlowEditor.test.tsx src/features/flows/sqlGeneration.test.ts electron/ipc/architecture.test.ts`  
Expected: PASS.

Run: `git add src/features/flows/StepPreviewDialog.tsx src/features/flows/StepPreviewDialog.test.tsx src/features/flows/flows.api.tsx src/features/flows/flows.types.tsx src/features/flows/FlowEditor.tsx src/features/flows/QueryStepEditor.tsx src/features/flows/QueryStepEditor.test.tsx src/features/flows/sqlGeneration.ts src/features/flows/sqlGeneration.test.ts src/styles/global.css; git commit -m "feat: preview and run flow editor steps"`

### Task 4: Document and protect the preview-only exception

**Files:**
- Modify: `AGENTS.md`, `ARCHITECTURE.md`, `electron/ipc/architecture.test.ts`

- [ ] **Step 1: Write failing active-document assertion**

```ts
it("documents source rows as a transient preview-only IPC exception", () => {
  expect(readFileSync(resolve(workspace, "ARCHITECTURE.md"), "utf8"))
    .toMatch(/preview_flow_step[\s\S]*source rows[\s\S]*not.*history/iu);
});
```

- [ ] **Step 2: Verify failure, update, and verify green**

Run: `pnpm vitest run electron/ipc/architecture.test.ts -t "preview-only IPC exception"`  
Expected: FAIL.

Change both active documents to name `preview_flow_step` as the sole temporary source-row exception; state no rows in logs, SQLite, history, or other DTOs and that closing clears renderer state. Keep all password/bind/generic-SQL restrictions.

Run: `pnpm vitest run electron/ipc/architecture.test.ts`  
Expected: PASS.

- [ ] **Step 3: Commit documentation**

Run: `git add AGENTS.md ARCHITECTURE.md electron/ipc/architecture.test.ts; git commit -m "docs: define preview-only source row handling"`

### Task 5: Verify the completed feature

**Files:** Verify only; preserve unrelated user changes.

- [ ] **Step 1: Check whitespace**

Run: `git diff --check HEAD~4..HEAD`  
Expected: no output, exit 0.

- [ ] **Step 2: Run required checks**

Run: `pnpm vitest run electron/ipc/architecture.test.ts`  
Expected: PASS.

Run: `pnpm test`  
Expected: PASS.

Run: `pnpm lint`  
Expected: PASS.

Run: `pnpm build`  
Expected: PASS.

Run: `pnpm package`  
Expected: PASS.

- [ ] **Step 3: Report evidence**

Report all command outputs and commits. State that all preview rows are transient and no source rows enter persistence, logs, or run history. If packaging fails due to environment-specific native dependencies, report the exact failure without claiming success.
