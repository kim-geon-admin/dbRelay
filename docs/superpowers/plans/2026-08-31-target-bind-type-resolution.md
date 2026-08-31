# Target Bind Type Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute editable-preview binds using Oracle numeric bind values when target-column metadata is complete, while preserving string/null fallback behavior when it is not.

**Architecture:** Reuse the existing restrictive `UPDATE`/`INSERT`/generated-`MERGE` parser to expose a target-column-to-bind mapping. The main process asks a typed Oracle-session metadata method for only those target column classifications immediately before target DML. It converts the transient, saved preview batch only when every required classification is available; otherwise it passes the string/null batch through unchanged.

**Tech Stack:** TypeScript, Electron main process, node-oracledb 6.x, Vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-31-target-bind-type-resolution-design.md`

## Global Constraints

- Preserve the context-isolated typed IPC boundary; do not expose generic SQL, raw rows, bind values, credentials, or metadata query text to the renderer, logs, history, or SQLite.
- Apply target-type conversion only to named binds mapped by the supported target-DML parser.
- `null` remains `null`; a complete metadata lookup converts Oracle `NUMBER`, `FLOAT`, `BINARY_FLOAT`, and `BINARY_DOUBLE` bindings to `number` or `bigint`; other known types become strings.
- `USER_TAB_COLUMNS`, then `ALL_TAB_COLUMNS`, are the only metadata lookups. Missing or partial metadata falls back to unchanged string/null values; do not run SQL*Plus `DESC` or any `SELECT ... WHERE 1 = 0` fallback.
- Keep the locked `oracledb@6.10.0` dependency; its 6.5+ `bigint` to `DB_TYPE_NUMBER` support is required for large integer target values.
- Run `pnpm vitest run electron/ipc/architecture.test.ts` for boundary changes and complete `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package` before handoff.

---

### Task 1: Expose target-column/bind mappings from supported DML

**Files:**
- Modify: `electron/domain/restorableDml.ts`
- Modify: `electron/domain/restorableDml.test.ts`

**Interfaces:**
- Produces `RestorableDmlPlan.bindColumns: Array<{ column: string; bindName: string }>`.
- `bindColumns` includes assignment and predicate binds for `UPDATE`, insert value binds for `INSERT`, and `USING (SELECT :bind column ...)` binds for generated `MERGE`.
- Existing `keyTerms` and `assignedColumns` remain unchanged for step restore.

- [ ] **Step 1: Write the failing parser tests**

```ts
it("maps update assignments and key predicates to target columns", () => {
  expect(parseRestorableDml(
    "UPDATE TGT_USERS SET LOGIN_ID = :LOGIN_ID WHERE USER_ID = :USER_ID",
  )?.bindColumns).toEqual([
    { column: "LOGIN_ID", bindName: "LOGIN_ID" },
    { column: "USER_ID", bindName: "USER_ID" },
  ]);
});

it("maps insert value binds and generated merge projection binds", () => {
  const generatedMergeSql = "MERGE INTO TGT_USERS target USING (SELECT :USER_ID USER_ID, :LOGIN_ID LOGIN_ID FROM dual) source ON (target.USER_ID = source.USER_ID) WHEN MATCHED THEN UPDATE SET target.LOGIN_ID = source.LOGIN_ID WHEN NOT MATCHED THEN INSERT (USER_ID, LOGIN_ID) VALUES (source.USER_ID, source.LOGIN_ID)";
  expect(parseRestorableDml(
    "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID) VALUES (:USER_ID, :LOGIN_ID)",
  )?.bindColumns).toEqual([
    { column: "USER_ID", bindName: "USER_ID" },
    { column: "LOGIN_ID", bindName: "LOGIN_ID" },
  ]);
  expect(parseRestorableDml(generatedMergeSql)?.bindColumns).toEqual([
    { column: "USER_ID", bindName: "USER_ID" },
    { column: "LOGIN_ID", bindName: "LOGIN_ID" },
  ]);
});
```

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `pnpm vitest run electron/domain/restorableDml.test.ts`

Expected: FAIL because `bindColumns` is absent.

- [ ] **Step 3: Implement the minimal mapping extension**

```ts
export type TargetBindColumn = { column: string; bindName: string };

export type RestorableDmlPlan = {
  kind: "insert" | "update" | "upsert";
  table: string;
  keyTerms: TargetBindColumn[];
  assignedColumns: string[];
  bindColumns: TargetBindColumn[];
};
```

Make `assignmentColumns` return `{ column, bindName }` entries for direct
updates. Make `parseInsert` pair each parsed target column with its `:bind`.
Retain the existing merge projection map and invert it into the generated
merge's bind-column list. Deduplicate with the existing case-insensitive
identifier key behavior, preserving first appearance.

- [ ] **Step 4: Run the domain test to verify it passes**

Run: `pnpm vitest run electron/domain/restorableDml.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the parser task**

```powershell
git add electron/domain/restorableDml.ts electron/domain/restorableDml.test.ts
git commit -m "feat: map target columns to DML binds"
```

### Task 2: Add typed Oracle target-column metadata lookup

**Files:**
- Modify: `electron/connectors/databaseConnector.ts`
- Modify: `electron/connectors/oracleConnector.ts`
- Modify: `electron/connectors/oracleConnector.test.ts`

**Interfaces:**
- Produces `TargetColumnKind = "numeric" | "text"`.
- Adds optional `DatabaseSession.describeTargetColumns?(table, columns): Promise<Record<string, TargetColumnKind>>`.
- `OracleSession.describeTargetColumns` queries `USER_TAB_COLUMNS` first and tries `ALL_TAB_COLUMNS` only when the first result is incomplete.

- [ ] **Step 1: Write the failing connector tests**

```ts
it("classifies Oracle numeric target columns from USER_TAB_COLUMNS", async () => {
  const { connector, connection } = fixture({
    execute: vi.fn().mockResolvedValue({
      metaData: [{ name: "COLUMN_NAME" }, { name: "DATA_TYPE" }],
      rows: [{ COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" }, { COLUMN_NAME: "LOGIN_ID", DATA_TYPE: "VARCHAR2" }],
    }),
  });
  const session = await connector.open(profile(), "secret");

  await expect(session.describeTargetColumns!("TGT_USERS", ["USER_ID", "LOGIN_ID"]))
    .resolves.toEqual({ USER_ID: "numeric", LOGIN_ID: "text" });
  expect(connection.execute).toHaveBeenCalledWith(
    expect.stringContaining("USER_TAB_COLUMNS"), expect.anything(), expect.anything(),
  );
});

it("uses ALL_TAB_COLUMNS when USER_TAB_COLUMNS is incomplete", async () => {
  const { connector, connection } = fixture({
    execute: vi.fn()
      .mockResolvedValueOnce({ metaData: [], rows: [{ COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" }] })
      .mockResolvedValueOnce({ metaData: [], rows: [{ COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" }, { COLUMN_NAME: "LOGIN_ID", DATA_TYPE: "VARCHAR2" }] }),
  });
  const session = await connector.open(profile(), "secret");

  await expect(session.describeTargetColumns!("TGT_USERS", ["USER_ID", "LOGIN_ID"]))
    .resolves.toEqual({ USER_ID: "numeric", LOGIN_ID: "text" });
  expect(connection.execute.mock.calls[1][0]).toContain("ALL_TAB_COLUMNS");
});

it("binds a bigint as DB_TYPE_NUMBER", async () => {
  const { connector, connection } = fixture();
  const session = await connector.open(profile(), "secret");

  await session.executeNamed("UPDATE TGT_USERS SET USER_ID = :USER_ID", [{
    USER_ID: 9_007_199_254_740_993n,
  }]);

  expect(connection.executeMany).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
    autoCommit: false,
    bindDefs: { USER_ID: { type: "DB_TYPE_NUMBER" } },
  });
});
```

- [ ] **Step 2: Run the connector test to verify it fails**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

Expected: FAIL because `describeTargetColumns` is absent.

- [ ] **Step 3: Implement the typed lookup**

```ts
export type TargetColumnKind = "numeric" | "text";

export interface DatabaseSession {
  // existing members
  describeTargetColumns?(
    table: string,
    columns: readonly string[],
  ): Promise<Record<string, TargetColumnKind>>;
}
```

Use parameterized values for the normalized validated table and requested
columns. Return case-normalized keys and classify only `NUMBER`, `FLOAT`,
`BINARY_FLOAT`, and `BINARY_DOUBLE` as `numeric`. Treat all other dictionary
data types as `text`. A result is complete only when every requested column has
one unambiguous classification. When the user dictionary result is incomplete,
query `ALL_TAB_COLUMNS`; return an empty object when that result is also
incomplete or ambiguous. Convert database errors through the existing secret
masking `ConnectorError` path. Update the existing `bindKind`/`bindDefinition`
path so `bigint` uses `DB_TYPE_NUMBER` instead of producing
`BIND_TYPE_UNSUPPORTED`; retain all other unsupported bind safeguards.

- [ ] **Step 4: Run the connector test to verify it passes**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the connector task**

```powershell
git add electron/connectors/databaseConnector.ts electron/connectors/oracleConnector.ts electron/connectors/oracleConnector.test.ts
git commit -m "feat: resolve Oracle target column kinds"
```

### Task 3: Coerce saved-preview values before target DML

**Files:**
- Modify: `electron/application/migrationRunner.ts`
- Modify: `electron/application/migrationRunner.test.ts`

**Interfaces:**
- Produces `coerceSavedPreviewBatch(rows, bindColumns, columnKinds): NamedRow[]` as a private main-process helper.
- Consumes the optional session lookup only after `prepareRowSetBatch` has mapped source-column aliases to named binds and before target `begin`.
- Falls back to the unchanged batch if parser data, the session lookup, or a complete column-kind mapping is unavailable.

- [ ] **Step 1: Write failing runner tests**

```ts
async function runSavedPreviewWithKinds(
  kinds: Record<string, "numeric" | "text">,
  row: NamedRow,
) {
  const test = harness("all_or_nothing").targetColumnKinds(kinds);
  const preview = await test.runner.previewFlowStep({
    sourceConnectionId: "source", selectSql: "SELECT user_id, login_id FROM SRC_USERS",
  });
  test.runner.saveEditedPreview({
    previewId: preview.previewId,
    columns: ["USER_ID", "LOGIN_ID"], rows: [row],
  });
  await test.runner.runFlowStep({
    sourceConnectionId: "source", targetConnectionId: "target",
    selectSql: "SELECT user_id, login_id FROM SRC_USERS",
    upsertSql: "UPDATE TGT_USERS SET LOGIN_ID = :LOGIN_ID WHERE USER_ID = :USER_ID",
    previewId: preview.previewId,
  });
  return test;
}

it("coerces saved preview values from complete target metadata", async () => {
  const test = await runSavedPreviewWithKinds({
    USER_ID: "numeric", LOGIN_ID: "text",
  }, { USER_ID: "123", LOGIN_ID: 123 });

  expect(test.connector.executedRows[0]).toEqual({ USER_ID: 123, LOGIN_ID: "123" });
});

it("retains null and uses bigint for a large integral numeric preview value", async () => {
  const test = await runSavedPreviewWithKinds({
    USER_ID: "numeric", LOGIN_ID: "text",
  }, {
    USER_ID: "9007199254740993", LOGIN_ID: null,
  });

  expect(test.connector.executedRows[0]).toEqual({
    USER_ID: 9_007_199_254_740_993n,
    LOGIN_ID: null,
  });
});

it("falls back to string binds when target metadata is incomplete", async () => {
  const test = await runSavedPreviewWithKinds({ USER_ID: "numeric" }, {
    USER_ID: "123", LOGIN_ID: "123",
  });

  expect(test.connector.executedRows[0]).toEqual({ USER_ID: "123", LOGIN_ID: "123" });
});

it("rejects nonnumeric text for a known numeric target column", async () => {
  const test = harness("all_or_nothing").targetColumnKinds({
    USER_ID: "numeric", LOGIN_ID: "text",
  });
  const preview = await test.runner.previewFlowStep({
    sourceConnectionId: "source", selectSql: "SELECT user_id, login_id FROM SRC_USERS",
  });
  test.runner.saveEditedPreview({
    previewId: preview.previewId,
    columns: ["USER_ID", "LOGIN_ID"], rows: [{ USER_ID: "abc", LOGIN_ID: "123" }],
  });

  await expect(test.runner.runFlowStep({
    sourceConnectionId: "source", targetConnectionId: "target",
    selectSql: "SELECT user_id, login_id FROM SRC_USERS",
    upsertSql: "UPDATE TGT_USERS SET LOGIN_ID = :LOGIN_ID WHERE USER_ID = :USER_ID",
    previewId: preview.previewId,
  })).rejects.toMatchObject({ code: "BIND_TYPE_UNSUPPORTED" });
  expect(test.connector.targetTransactions()).toEqual([]);
});
```

- [ ] **Step 2: Run the runner test to verify it fails**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "saved preview values"`

Expected: FAIL because the target session has no metadata lookup and preview
rows are passed through without conversion.

- [ ] **Step 3: Implement minimal coercion and harness support**

Add `targetColumnKinds` and `executedRows` to `RecordingConnector`. Its target
session's optional lookup returns a cloned configured map. In `runFlowStep`,
call `parseRestorableDml`, request kinds for its `bindColumns`, and replace the
saved-preview batch only when the returned keys cover every mapped column.

Use a `coerceNumeric` helper that accepts finite `number`, `bigint`, or decimal
string input. It returns a safe `number`, an integral `bigint` outside the safe
integer range, or a safe `RunError.connector("BIND_TYPE_UNSUPPORTED", ...)`
for invalid or non-losslessly representable decimal input. For a `text` column,
convert scalar non-null values with `String(value)`; retain `null` unchanged.
Do not apply this conversion to ordinary source-query execution without a saved
preview.

- [ ] **Step 4: Run the runner test to verify it passes**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "saved preview values"`

Expected: PASS.

- [ ] **Step 5: Commit the runner task**

```powershell
git add electron/application/migrationRunner.ts electron/application/migrationRunner.test.ts
git commit -m "feat: coerce saved preview binds by target type"
```

### Task 4: Preserve preview editing behavior and create manual Flow fixtures

**Files:**
- Modify: `src/features/flows/StepPreviewDialog.test.tsx`
- Runtime data: `C:\Users\kg\AppData\Roaming\db-relay\db-relay.sqlite`

**Interfaces:**
- The preview dialog continues to save a blank input as `null` and does not
  compare an edit against the source value's type.
- Produces three saved, unexecuted Flow records using `로컬` as source and target:
  `TGT_USERS 타입 테스트 - UPDATE`, `TGT_USERS 타입 테스트 - INSERT`, and
  `TGT_USERS 타입 테스트 - UPSERT`.

- [ ] **Step 1: Verify the existing UI regression test**

```ts
test("saves an empty preview cell as null without source-type validation", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-null", columns: ["USER_ID"], rows: [{ USER_ID: 7 }],
  }} onClose={vi.fn()} onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "USER_ID row 1" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(onSave).toHaveBeenCalledWith({
    columns: ["USER_ID"], rows: [{ USER_ID: null }],
  });
});
```

- [ ] **Step 2: Run the UI test to verify it passes**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx`

Expected: PASS; this verifies the previously approved removal of original-type
validation has not regressed.

- [ ] **Step 3: Save the three Flow fixtures without executing them**

Use the main-process `SqliteRepository` schema and the existing `로컬`
connection ID read from the local SQLite database. Do not select, print, or
modify its password. Save one-step flows with source SQL selecting `USER_ID`
and `LOGIN_ID` from `SRC_USERS` with `WHERE ROWNUM = 1`, and target SQL in
these forms:

```sql
UPDATE TGT_USERS SET LOGIN_ID = :LOGIN_ID WHERE USER_ID = :USER_ID
INSERT INTO TGT_USERS (USER_ID, LOGIN_ID) VALUES (:USER_ID, :LOGIN_ID)
MERGE INTO TGT_USERS target
USING (SELECT :USER_ID USER_ID, :LOGIN_ID LOGIN_ID FROM dual) source
ON (target.USER_ID = source.USER_ID)
WHEN MATCHED THEN UPDATE SET target.LOGIN_ID = source.LOGIN_ID
WHEN NOT MATCHED THEN INSERT (USER_ID, LOGIN_ID) VALUES (source.USER_ID, source.LOGIN_ID)
```

Use deterministic fixture IDs and `INSERT ... ON CONFLICT(id) DO UPDATE`-style
repository saves so rerunning fixture creation updates only these three named
flows. Confirm by listing only flow IDs/names, source/target connection IDs,
and transaction policy; do not execute the flows or print stored SQL.

- [ ] **Step 4: Run all required verification**

Run:

```powershell
pnpm test
pnpm vitest run electron/ipc/architecture.test.ts
pnpm lint
pnpm build
pnpm package
```

Expected: every command exits with code 0. The Oracle integration test remains
opt-in and is not run unless `DB_RELAY_ORACLE_TEST_URL` is configured.

- [ ] **Step 5: Commit the application code and tests**

```powershell
git add electron src
git commit -m "feat: resolve target bind types for preview runs"
```
