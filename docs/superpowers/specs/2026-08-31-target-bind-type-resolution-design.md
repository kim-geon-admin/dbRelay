# Target bind type resolution design

## Goal

When an editable preview is run through an Oracle `UPDATE`, `INSERT`, or
generated `MERGE`, bind values for known numeric target columns must be sent as
numeric values. Other values remain strings, and an empty preview cell remains
`null`.

The existing "keep the original preview type" rule remains removed. Target
column metadata, rather than the source preview type, determines whether a
non-null edited value is converted.

## Scope and safety

- The work applies only to named binds in supported `UPDATE`, `INSERT`, and
  generated `MERGE` target SQL shapes.
- The main process resolves metadata and converts values immediately before
  target execution. Raw preview rows, bind values, and metadata queries do not
  cross the renderer IPC boundary or enter logs, history, or SQLite.
- SQL literals are not converted. Values must use named binds to participate in
  this behavior.
- The app never executes SQL*Plus `DESC`; it is not database SQL and is not a
  valid node-oracledb command.

## Resolution and fallback

1. Parse validated target SQL to map each named bind to its target column.
2. The Oracle connector reads the required column types from `USER_TAB_COLUMNS`.
3. If no result is returned, or if any required bind column is missing, it tries
   `ALL_TAB_COLUMNS`.
4. If the type mapping is still incomplete, execution proceeds with the cached
   preview values unchanged: all non-null editable values are strings and
   `null` remains `null`.

For a complete mapping, Oracle `NUMBER`, `FLOAT`, `BINARY_FLOAT`, and
`BINARY_DOUBLE` columns are numeric. Values for those columns are converted to
`number` when safely representable and to `bigint` for integral values outside
the safe JavaScript integer range. All other target types retain string values.

An invalid numeric string is rejected before DML with the existing safe bind
diagnostic; no value or SQL text is projected to the renderer.

## Components

- The target-DML parser gains a bind-to-column mapping for each supported DML
  shape.
- `DatabaseSession` gains a typed, connector-internal target-column metadata
  operation.
- `OracleSession` implements the two dictionary queries, projects only a
  numeric/non-numeric classification, and preserves safe connector errors.
- `MigrationRunner.runFlowStep` converts a saved preview batch after opening the
  target session and before `begin`/DML. A missing or partial classification
  returns the original string/null batch unchanged.

## Testing

- Domain tests cover bind-to-column mappings for update, insert, and merge.
- Runner tests cover `null`, numeric and text conversion, and incomplete
  dictionary metadata falling back to strings.
- Oracle connector tests cover `USER_TAB_COLUMNS` first, `ALL_TAB_COLUMNS`
  fallback, and numeric classifications.
- UI tests retain no original-type validation and prove empty preview cells save
  as `null`.

## Manual test flows

After automated verification, save but do not execute three flows using the
existing `로컬` connection as both source and target and the existing
`SRC_USERS` to `TGT_USERS` relationship:

- one `UPDATE` flow;
- one `INSERT` flow;
- one generated-shape `MERGE` (upsert) flow.

Each flow selects `USER_ID` and `LOGIN_ID` under matching named-bind aliases so
preview edits can exercise a numeric `USER_ID`, a string `LOGIN_ID`, and an
empty cell becoming `null`.
