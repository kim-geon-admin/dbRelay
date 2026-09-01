# DB Relay Product Specification

DB Relay lets a local Windows user define reusable migration flows between configured databases. The first connector is Oracle.

Each flow references a source and target connection setting, an ordered list of source-query/target-upsert steps, and either `all_or_nothing` or `commit_successes` transaction policy. Column aliases map case-insensitively to named target bind parameters; missing or duplicate mappings block execution before it starts.

`all_or_nothing` performs every target change in one transaction and rolls back all changes if a step fails. `commit_successes` commits successful steps independently, then pauses after a failed step for one explicit action: edit and retry, skip and continue, or stop.

The React renderer reaches application operations only through the context-isolated Electron preload and typed IPC command allowlist. SQLite persistence and Oracle connectivity through `oracledb@^6.2.0` stay in the Electron main process.

Execution history records the flow ID and name snapshot, source/target display names, flow version, safe status, timing, counts, native error context, and recovery choices. Bound-run updates retain this metadata through every state transition, including all-or-nothing commit and rollback paths. History is presented newest-started first; the flow name is the card/detail title and is not repeated in a redundant `Flow:` row. It never stores or displays credentials, bind values, or source rows. Current connection passwords are stored as plaintext in the local SQLite database, which must be treated as sensitive. Connection editing and IPC responses expose only `*` characters matching a saved password's length, never the raw password.

The run-history screen keeps the selected detail in the same main view as the list. Clicking a history item expands its detail beneath that item while the surrounding list remains in place; opening a different item moves the detail to the newly selected item. Individual records and the entire history can be deleted from the UI without an additional filter condition; both operations use the same typed IPC boundary and refresh the list after completion.

Run logs prefer Korean explanations. Known Oracle codes use the maintained Korean catalog and show the code with an actionable Korean description; an English fallback is used only when no Korean catalog entry exists. Connector diagnostics are intentionally sanitized: they may identify a bind name and type mismatch, but never expose bind values, source rows, credentials, SQL text, or unsanitized driver details.

The flow editor keeps Source SQL and Target SQL as ordinary editable monospaced textareas without line numbers or syntax-color overlays. `Ctrl+F` formats only the focused SQL field using the Oracle formatter. Insert, update, and upsert Target SQL guides are generated from the Source SQL `SELECT` columns; generation does not query target primary-key metadata. Upsert/MERGE examples include Korean guidance comments explaining which source values and ON/UPDATE/INSERT clauses require review.

An insert step whose Source SQL selects `*` from a single table has no column list to generate from, so its Target SQL stays empty with an explanation until the user previews the step; saving the edited preview then generates the `INSERT` from the preview columns. The table may carry a trailing clause that cannot introduce a second table — `WHERE`, `ORDER BY`, and the like, with or without a table alias — while a join, comma join, union, or subquery source keeps the explanation instead of naming the wrong target. A failed generation never clears Target SQL the step already has.

Saving an edited preview always succeeds while the preview is still open. The dialog does not validate cell types or the column set, because a value the target rejects is reported by Run against the real database rather than blocking the edit. `DATE` cells are shown and edited as `YYYY-MM-DD HH:MM:SS` and `TIMESTAMP` cells as `YYYY-MM-DD HH:MM:SS.ffffff`; the driver reads temporal columns at millisecond resolution, so the last three fractional digits are always zero and an edit is stored at the same resolution.

The disposable Oracle integration scenario is enabled with `DB_RELAY_ORACLE_TEST_URL=oracle://user:password@host:port/SID`; it skips when the environment variable is absent. Release verification runs `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`.
