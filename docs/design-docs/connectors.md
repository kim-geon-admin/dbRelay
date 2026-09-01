# Connector Design Notes

`DatabaseConnector` is the Electron main-process extension boundary for database drivers. A connector validates a connection profile, queries rows, executes named-bind upserts, and controls target transactions while preserving database-native error information in a safe `ConnectorError`. Renderer and preload modules never import a driver.

The first implementation is `OracleConnector`, backed by `oracledb@^6.2.0`, which executes Oracle `MERGE` statements with named `executeMany` binds. Future connectors register through `ConnectorRegistry`; `MigrationRunner` remains connector-agnostic.

Temporal values cross the connector boundary as structured parts rather than driver objects. The Oracle session fixes `NLS_DATE_FORMAT`, `NLS_TIMESTAMP_FORMAT`, and `NLS_TIMESTAMP_TZ_FORMAT` before its first statement — on target sessions too, so a text bind reaching a temporal column converts through a known format — and reads `DATE` and `TIMESTAMP` from the driver's `Date` values. That fixes the resolution at milliseconds: a `TIMESTAMP(6)` column reads back as `.123000`, and binds are truncated to the same resolution so a written row still matches the value a later read returns. Text a session format leaves unparsable is preserved verbatim instead of omitting the column, which would hide a populated value from the preview.

Connectors receive credential material only at execution time. Current passwords are plaintext in the local SQLite profile, but the preload/IPC boundary returns only a same-length `passwordMask`. Connectors must not write secrets, bind values, source rows, or connection strings containing passwords to logs, history, or command DTOs.

Connector failures are projected before reaching renderer log/history surfaces. Oracle error codes are mapped to the Korean catalog with a Korean-first explanation; unknown codes use a safe generic fallback. `BIND_TYPE_UNSUPPORTED` diagnostics may retain the bind identifier and unsupported type category to help troubleshooting, but never the actual bind value, source row, SQL text, password, or raw driver message.

Set `DB_RELAY_ORACLE_TEST_URL` to `oracle://user:password@host:port/SID` to enable the disposable Oracle integration test; it skips when unset. The active checks are `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`.
