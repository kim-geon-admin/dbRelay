# Generic Step Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Edit Flow inserts, updates, and upserts without a fixed `USER_ID` column, while explaining unavailable restoration in the UI.

**Architecture:** Parse a narrow, safe Target SQL grammar into a generic restore plan. Update and Merge plans query pre/post target rows by extracted equality keys; Insert plans collect actual inserted `ROWID`s through Oracle `RETURNING`. Cache only target snapshots and rowids in main-process memory. IPC returns a safe availability enum for the renderer.

**Tech Stack:** Electron main process, TypeScript, React, Vitest, `oracledb@^6.2.0`, Local2 Oracle integration test.

**Spec:** `docs/superpowers/specs/2026-08-29-generic-step-restore-design.md`

## Global Constraints

- Source rows, credentials, Target bind values, and SQL text remain outside renderer/history/logging surfaces.
- Support only parser-owned identifiers and simple `AND` equality conditions; unsupported Target SQL still runs without restore.
- The restore cache is main-process memory only and is cleared on new Run, restore success, and editor unmount.
- Run `pnpm vitest run electron/ipc/architecture.test.ts` for every Electron boundary change.

---

### Task 1: Generic target restore-plan parser

**Files:**
- Create: `electron/domain/restorableTargetSql.ts`
- Create: `electron/domain/restorableTargetSql.test.ts`
- Modify: `electron/domain/restorableDml.ts` or replace callers in `electron/application/migrationRunner.ts`

**Interfaces:**
- Produces `parseRestorableTargetSql(sql): RestorableTargetPlan | { reason: "target_sql_not_restorable" }`.
- `RestorableTargetPlan` contains `kind`, validated `table`, `keyTerms: { column; bindName }[]`, and changed-column metadata.

- [ ] **Step 1: Write failing parser tests**

```ts
expect(parseRestorableTargetSql(
  "UPDATE accounts SET label = :label WHERE login_id = :login_id AND tenant_id = :tenant_id",
)).toMatchObject({ kind: "update", keyTerms: [{ column: "login_id", bindName: "login_id" }, { column: "tenant_id", bindName: "tenant_id" }] });
expect(parseRestorableTargetSql("UPDATE accounts SET label = :label WHERE login_id = :login_id OR tenant_id = :tenant_id")).toBeUndefined();
```

- [ ] **Step 2: Run parser tests and observe failure**

Run: `pnpm vitest run electron/domain/restorableTargetSql.test.ts`

- [ ] **Step 3: Implement narrow lexical parsing**

```ts
type KeyTerm = { column: string; bindName: string };
type RestorableTargetPlan = { kind: "insert" | "update" | "upsert"; table: string; keyTerms: KeyTerm[]; changedColumns: string[] };
```

Accept validated ordinary/double-quoted identifiers; split only top-level `AND`; reject every non-equality term and every pre-existing `RETURNING` clause.

- [ ] **Step 4: Run parser tests and affected legacy parser tests**

Run: `pnpm vitest run electron/domain/restorableTargetSql.test.ts electron/domain/restorableDml.test.ts`

### Task 2: Oracle Insert `ROWID` return path

**Files:**
- Modify: `electron/connectors/databaseConnector.ts`
- Modify: `electron/connectors/oracleConnector.ts`
- Modify: `electron/connectors/oracleConnector.test.ts`

**Interfaces:**
- Adds optional `executeNamedReturningRowIds(sql, rows): Promise<{ affectedRows: number; rowIds: string[] }>` to `DatabaseSession`.
- Only generic restore Insert calls this method.

- [ ] **Step 1: Write failing Oracle-session test**

```ts
await expect(session.executeNamedReturningRowIds(
  "INSERT INTO target (id) VALUES (:ID) RETURNING ROWID INTO :DBR_RESTORE_ROWID",
  [{ ID: 1 }],
)).resolves.toEqual({ affectedRows: 1, rowIds: ["AAA"] });
```

- [ ] **Step 2: Run connector test and observe failure**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

- [ ] **Step 3: Implement executeMany out-bind conversion**

Use a private, parser-owned `DBR_RESTORE_ROWID` bind definition. Return rowids only to `MigrationRunner`; never include them in a renderer DTO.

- [ ] **Step 4: Run connector tests**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

### Task 3: Generic runner snapshots and availability

**Files:**
- Modify: `electron/application/stepRestoreCache.ts`
- Modify: `electron/application/migrationRunner.ts`
- Modify: `electron/application/migrationRunner.test.ts`

**Interfaces:**
- `runFlowStep()` returns `{ affectedRows; restoreId?; restoreAvailability }`.
- `RestoreAvailability` is a safe enum defined in main-process domain/IPC DTOs.

- [ ] **Step 1: Write failing runner tests**

```ts
await expect(runner.runFlowStep({ upsertSql: "UPDATE accounts SET label = :label WHERE login_id = :login_id" }))
  .resolves.toMatchObject({ restoreAvailability: "ready", restoreId: expect.any(String) });
await expect(runner.runFlowStep({ upsertSql: "UPDATE accounts SET label = :label WHERE login_id = :login_id OR tenant_id = :tenant_id" }))
  .resolves.toEqual({ affectedRows: 1, restoreAvailability: "target_sql_not_restorable" });
```

- [ ] **Step 2: Run runner tests and observe failure**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

- [ ] **Step 3: Implement snapshot execution**

Build parameterized snapshot SQL from parser-owned table/key identifiers. Capture `ROWID` plus changed columns before and after Update/Merge. Derive Insert actions from returned rowids. Preserve rollback and optimistic expected-value checks.

- [ ] **Step 4: Run runner tests**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

### Task 4: Safe IPC availability DTO

**Files:**
- Modify: `electron/ipc/commands.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/ipc/handlers.test.ts`
- Modify: `electron/ipc/architecture.test.ts`
- Modify: `src/lib/desktop.ts`
- Modify: `src/features/flows/flows.api.tsx`

**Interfaces:**
- Renderer receives only `affectedRows`, opaque `restoreId`, and `restoreAvailability`.

- [ ] **Step 1: Write failing handler projection test**

```ts
vi.spyOn(services.runs, "runFlowStep").mockResolvedValue({ affectedRows: 1, restoreAvailability: "target_sql_not_restorable", selectSql: "secret" } as never);
await expect(handler("run_flow_step", request)).resolves.toEqual({ affectedRows: 1, restoreAvailability: "target_sql_not_restorable" });
```

- [ ] **Step 2: Run IPC tests and observe failure**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts`

- [ ] **Step 3: Add enum and explicit handler projection**

Keep raw SQL, source rows, bind data, cache actions, and credentials excluded from all DTOs.

- [ ] **Step 4: Run IPC tests**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts`

### Task 5: Restore reason UI and interaction

**Files:**
- Modify: `src/features/flows/QueryStepEditor.tsx`
- Modify: `src/features/flows/QueryStepEditor.test.tsx`
- Modify: `src/styles/global.css`

**Interfaces:**
- Restore control holds `aria-disabled` and blocks restore calls when unavailable.
- A `RestoreAvailability` to Korean-message map returns a stable lower-step message.

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(screen.getByRole("button", { name: "복원" })).toHaveAttribute("aria-disabled", "true");
fireEvent.click(screen.getByRole("button", { name: "복원" }));
expect(await screen.findByRole("alert")).toHaveTextContent("AND로 연결된 단순 동등 WHERE/ON 조건");
```

- [ ] **Step 2: Run UI tests and observe failure**

Run: `pnpm vitest run src/features/flows/QueryStepEditor.test.tsx`

- [ ] **Step 3: Implement non-executing disabled click feedback**

Keep previous cache ready through SQL text edits. At Run start set `busy`; consume returned availability at completion; map arbitrary Target SQL, `OR`, no successful Run, failed Run, busy, and missing-cache cases to Korean help text.

- [ ] **Step 4: Run UI tests**

Run: `pnpm vitest run src/features/flows/QueryStepEditor.test.tsx`

### Task 6: Local2 generic-key workflows and final verification

**Files:**
- Modify: `electron/workflows/local2-step-restore.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-08-29-generic-step-restore-design.md` only if test evidence requires a correction

- [ ] **Step 1: Write Local2 workflow assertions**

Persist two opt-in test flows using a non-`USER_ID` equality key for Update and Merge plus Insert. Assert every Run returns `ready`, every Restore affects expected rows, and all fixtures are restored.

- [ ] **Step 2: Run opt-in Local2 test**

Run: `$env:DB_RELAY_LOCAL2_RESTORE_TEST='1'; pnpm vitest run electron/workflows/local2-step-restore.integration.test.ts`

- [ ] **Step 3: Run required verification**

Run: `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm package`, and `pnpm vitest run electron/ipc/architecture.test.ts`.

