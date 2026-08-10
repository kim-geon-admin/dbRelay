# DB Relay Product Specification

DB Relay lets a local Windows user define reusable migration flows between configured databases. The first connector is Oracle.

Each flow references a source and target connection setting, an ordered list of source-query/target-upsert steps, and either `all_or_nothing` or `commit_successes` transaction policy. Column aliases map case-insensitively to named target bind parameters; missing or duplicate mappings block execution before it starts.

`all_or_nothing` performs every target change in one transaction and rolls back all changes if a step fails. `commit_successes` commits successful steps independently, then pauses after a failed step for one explicit action: edit and retry, skip and continue, or stop.

The React renderer reaches application operations only through the context-isolated Electron preload and typed IPC command allowlist. SQLite persistence and Oracle connectivity through `oracledb@^6.2.0` stay in the Electron main process.

Execution history records safe status, timing, counts, native error context, and recovery choices. It never stores or displays credentials, bind values, or source rows. Current connection passwords are stored as plaintext in the local SQLite database, which must be treated as sensitive. Connection editing and IPC responses expose only `*` characters matching a saved password's length, never the raw password.

The disposable Oracle integration scenario is enabled with `DB_RELAY_ORACLE_TEST_URL=oracle://user:password@host:port/SID`; it skips when the environment variable is absent. Release verification runs `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`.
