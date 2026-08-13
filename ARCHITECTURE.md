# DB Relay Architecture

## Dependency Direction

The only allowed dependency direction is:

```text
React renderer -> context-isolated preload -> typed IPC handlers -> application services
                                                                   |          |
                                                        domain rules     domain ports
                                                                   ^          ^
                                          main-process SQLite -----|----------|
                                          main-process connectors -|----------|
```

- The React renderer uses `window.dbRelay` only and cannot import Node, Electron, `oracledb`, SQLite, or credential implementations.
- The preload runs with `contextIsolation: true`, exposes only the named command allowlist, and projects typed IPC responses.
- The Electron main process owns IPC validation, application services, SQLite persistence, and database sessions.
- Domain rules stay independent of Electron and concrete drivers. Application services depend on domain contracts rather than renderer code.
- Connectors implement the `DatabaseConnector` contract. The Oracle implementation uses `oracledb@^6.2.0`; adding another database requires a connector and registry entry rather than renderer or `MigrationRunner` changes.

## Boundary Rules

Current connection profiles store their password as plaintext in the local SQLite database; legacy keyring-backed profiles remain readable. The database file is therefore sensitive. IPC connection responses expose only an asterisk mask matching the saved password's length, never the raw plaintext field or credential reference. Handlers never return passwords, SQL text, bind values, source rows, or execution credentials through run history. Run-history persistence stores a safe recovery binding (flow ID/version, connection IDs, and non-secret configuration fingerprints), then reloads and verifies the live flow/profile before recovery rather than serializing the executable flow or credentials.

Preview-only source-row handling: `preview_flow_step` is the sole transient source-row exception. Source rows never enter logs, SQLite, history, or other DTOs, and closing preview clears renderer state. Generic SQL remains prohibited; passwords, credentials, and target bind values remain excluded from renderer and history surfaces.

The Oracle connector maps `DATE` and timezone-free `TIMESTAMP` into structured domain values and uses node-oracledb typed `executeMany` binds. Capability preflight rejects ambiguous textual timestamps and timestamps with timezone offsets before target `begin`.

Oracle source sessions have no application-enforced read-only mode. Deployments must enforce source safety with a dedicated Oracle principal granted only the required `SELECT` privileges. SQL lexical validation is supplemental and cannot establish that a `SELECT` invoking user-defined functions is side-effect free.

## Enforced Architecture Checks

`electron/ipc/architecture.test.ts` protects the release boundaries:

- Renderer code cannot import main-process, database, Electron, or Node modules.
- Preload and main IPC expose only typed application operations; they do not expose generic arbitrary-SQL execution.
- Renderer connection DTOs expose `passwordMask`, not raw password or credential fields.
- Active source, configuration, CI, and operational documentation cannot restore the retired runtime.

The Windows CI workflow runs `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`. The optional Oracle integration scenario runs when `DB_RELAY_ORACLE_TEST_URL=oracle://user:password@host:port/SID` is supplied and otherwise skips.
