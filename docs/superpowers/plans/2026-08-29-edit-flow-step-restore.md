# Edit Flow Step Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-step `복원` action that reverses the latest committed supported Update, Insert, or Upsert Edit Flow run without exposing restoration data outside the Electron main process.

**Architecture:** A domain parser recognises only the generated single-table `USER_ID` SQL forms. `MigrationRunner` captures target before-images and inserted `ROWID`s inside the target transaction, stores typed restore actions in a volatile cache after commit, and runs a typed inverse action on restore. Renderer state retains only an opaque restore ID per step.

**Tech Stack:** Electron main/preload typed IPC, React 19, TypeScript, Vitest, node-oracledb 6.2+, Oracle `ROWID`/DML RETURNING.

**Spec:** `docs/superpowers/specs/2026-08-29-edit-flow-step-insert-restore-design.md`

## Global Constraints

- Support only direct Insert, `USER_ID` Update, and canonical generated `USER_ID` Merge; valid but unsupported DML remains runnable and non-restorable.
- Before-images, target after-images, `ROWID`s, source rows, bind values, and credentials stay only in main-process memory; never write or project them to SQLite, history, logs, renderer state, or IPC DTOs.
- A Run clears its own prior restore record before opening source/target work; an unmount clears all records owned by its editor session.
- Restoration is one target transaction; any conflict or error rolls it back and retains the record for retry.
- Do not add a generic SQL command. Run `pnpm vitest run electron/ipc/architecture.test.ts`, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package` before completion.

---

### Task 1: Parse supported DML and own restoration records

**Files:**
- Create: `electron/domain/restorableDml.ts`, `electron/domain/restorableDml.test.ts`
- Create: `electron/application/stepRestoreCache.ts`, `electron/application/stepRestoreCache.test.ts`

**Interfaces:**
- Produces `parseRestorableDml(sql): RestorableDmlPlan | undefined`.
- Produces `StepRestoreCache.create(entry): string`, `require(id)`, `discard(id)`, and `discardOwner(editorSessionId)`.

- [ ] **Step 1: Write parser and cache tests**

```ts
expect(parseRestorableDml("UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID"))
  .toMatchObject({ kind: "update", table: "TGT_USERS", keyColumn: "USER_ID", assignedColumns: ["DISPLAY_NAME"] });
expect(parseRestorableDml("MERGE INTO TGT_USERS target USING (SELECT :USER_ID USER_ID, :DISPLAY_NAME DISPLAY_NAME FROM dual) source ON (target.USER_ID = source.USER_ID) WHEN MATCHED THEN UPDATE SET target.DISPLAY_NAME = source.DISPLAY_NAME WHEN NOT MATCHED THEN INSERT (USER_ID, DISPLAY_NAME) VALUES (source.USER_ID, source.DISPLAY_NAME)"))
  .toMatchObject({ kind: "upsert", keyColumn: "USER_ID" });
expect(parseRestorableDml("UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE EMAIL = :EMAIL")).toBeUndefined();
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm vitest run electron/domain/restorableDml.test.ts electron/application/stepRestoreCache.test.ts`  
Expected: FAIL because the parser and cache do not exist.

- [ ] **Step 3: Implement narrow plans and volatile cache**

Define discriminated plans for `insert`, `update`, and `upsert`; include the preserved table text, `USER_ID` key, assignment/insert columns, and private DML RETURNING SQL only for Insert. Define restore actions as `delete { rowId, expectedValues }` or `update { rowId, previousValues, expectedValues }`. Deep-clone all values and never serialize cache entries.

- [ ] **Step 4: Run focused tests and verify green**

Run: `pnpm vitest run electron/domain/restorableDml.test.ts electron/application/stepRestoreCache.test.ts`  
Expected: PASS.

### Task 2: Add typed Oracle capture and inverse DML operations

**Files:**
- Modify: `electron/connectors/databaseConnector.ts`, `electron/connectors/oracleConnector.ts`
- Modify: `electron/connectors/oracleConnector.test.ts`

**Interfaces:**
- Adds `captureRestorationRows(plan, rows)`, `executeRestorableDml(plan, rows)`, and `applyRestoreActions(plan, actions)` to the session boundary.

- [ ] **Step 1: Write failing adapter tests**

```ts
await session.captureRestorationRows(updatePlan, [{ USER_ID: 1001, DISPLAY_NAME: "new" }]);
expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("WHERE USER_ID = :USER_ID"), expect.anything(), expect.anything());
await session.applyRestoreActions(updatePlan, [action]);
expect(connection.executeMany).toHaveBeenCalledWith(expect.stringContaining("WHERE ROWID = :__db_relay_restore_rowid"), expect.anything(), expect.anything());
```

- [ ] **Step 2: Run adapter tests and verify red**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`  
Expected: FAIL because the session methods are absent.

- [ ] **Step 3: Implement bound capture, DML RETURNING, and inverse actions**

Use validated parser-owned identifiers only. Query before-images by bound `USER_ID`; execute Insert plans with a reserved OUT bind for `ROWID`; create parameterized `UPDATE ... WHERE ROWID = :id AND assigned_column = :expected` and `DELETE ... WHERE ROWID = :id AND inserted_column = :expected` statements. Preserve current secret/error masking.

- [ ] **Step 4: Run adapter tests and verify green**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`  
Expected: PASS.

### Task 3: Wire main-process Run and Restore transactions

**Files:**
- Modify: `electron/application/migrationRunner.ts`, `electron/application/migrationRunner.test.ts`, `electron/main.ts`

**Interfaces:**
- Extends `runFlowStep` response to `{ affectedRows: number; restoreId?: string }`.
- Produces `restoreFlowStep({ restoreId })`, `discardStepRestore(restoreId)`, and `discardEditorRestores(editorSessionId)`.

- [ ] **Step 1: Write failing transaction tests**

```ts
const run = await test.runner.runFlowStep({ ...input, editorSessionId: "editor-1", stepId: "step-1" });
expect(run.restoreId).toEqual(expect.any(String));
await test.runner.restoreFlowStep({ restoreId: run.restoreId! });
expect(test.connector.targetTransactions()).toEqual(["begin", "capture", "execute:0", "commit", "begin", "restore", "commit"]);
```

- [ ] **Step 2: Run runner tests and verify red**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`  
Expected: FAIL because Run has no restore ID and Restore is absent.

- [ ] **Step 3: Implement cache lifecycle and transactions**

Clear the prior step record before a Run. Use the parsed plan when available, retain existing source/preview path otherwise, create a cache record only after commit, and clear pending data on all Run failures. Restore from an opaque ID only, commit all inverse actions or roll back and retain the record. Inject one cache from `main.ts`.

- [ ] **Step 4: Run runner tests and verify green**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`  
Expected: PASS.

### Task 4: Expose opaque restoration IPC and UI controls

**Files:**
- Modify: `electron/ipc/{commands,handlers,architecture.test}.ts`, `electron/ipc/handlers.test.ts`, `electron/preload.ts`, `electron/preload.test.ts`, `src/lib/desktop.ts`, `src/features/flows/{flows.api,flows.types,QueryStepEditor,QueryStepEditor.test}.tsx`

**Interfaces:**
- Adds `restore_flow_step`, `discard_step_restore`, and `discard_editor_restores` to the named allowlist.
- Adds `editorSessionId`/`stepId` only to `run_flow_step`; all restore commands accept only opaque IDs.

- [ ] **Step 1: Write failing handler and renderer tests**

```tsx
await userEvent.click(screen.getByRole("button", { name: "Run" }));
expect(await screen.findByRole("button", { name: "복원" })).toBeEnabled();
await userEvent.click(screen.getByRole("button", { name: "복원" }));
expect(screen.getByRole("button", { name: "복원" })).toBeDisabled();
```

- [ ] **Step 2: Run IPC and renderer tests and verify red**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/features/flows/QueryStepEditor.test.tsx`  
Expected: FAIL because commands and button state do not exist.

- [ ] **Step 3: Implement named commands and step-local UI state**

Validate opaque strings in handlers. Generate one editor session ID, retain only a restore ID per step, place `복원` immediately after Run, clear it before Run/configuration mutation/unmount, and retain it only after a successful restore failure. Project errors through the current lower `role="alert"` path. Strengthen architecture assertions to prohibit `ROWID`, values, rows, binds, and credentials in DTOs/history.

- [ ] **Step 4: Run IPC and renderer tests and verify green**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/features/flows/QueryStepEditor.test.tsx`  
Expected: PASS.

### Task 5: Create and run two Local2 workflow tests

**Files:**
- Modify: `electron/workflows/workflowTestHarness.ts`, `electron/workflows/workflow.integration.test.ts`
- Create: `electron/workflows/stepRestore.integration.test.ts`

**Interfaces:**
- Produces two saved Local2 test flows, each ordered `Update → Insert → Upsert`, using `SRC_USERS` and `TGT_USERS` with unique reserved IDs.

- [ ] **Step 1: Write opt-in two-flow integration test**

```ts
for (const flow of [existingFixtureFlow, additionalFixtureFlow]) {
  for (const step of flow.steps) {
    const run = await handler("run_flow_step", step);
    expect(run.restoreId).toEqual(expect.any(String));
    await assertChanged(step);
    await handler("restore_flow_step", { request: { restoreId: run.restoreId } });
    await assertOriginal(step);
  }
}
```

- [ ] **Step 2: Run opt-in test and verify red**

Run: `pnpm vitest run electron/workflows/stepRestore.integration.test.ts`  
Expected: skipped without a Local2-compatible Oracle URL; with Local2 configured, FAIL before the feature exists.

- [ ] **Step 3: Implement fixture preparation and cleanup**

Resolve Local2 through the app repository without projecting its password. Save two named flows, seed only unique reserved user rows, run/restore each step sequentially, assert before/changed/restored state, and remove only reserved rows in `finally`. Leave the two requested saved Flow definitions available for manual inspection.

- [ ] **Step 4: Run focused and full verification**

Run:

```powershell
pnpm vitest run electron/workflows/stepRestore.integration.test.ts
pnpm vitest run electron/ipc/architecture.test.ts
pnpm test
pnpm lint
pnpm build
pnpm package
```

Expected: all non-Oracle checks pass; actual Local2 workflow test passes when the stored Local2 profile can be opened.
