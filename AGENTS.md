# DB Relay Contributor Map

DB Relay is a Windows desktop application built with Electron, React, TypeScript, and pnpm. Oracle connectivity uses `oracledb@^6.2.0`.

## Read First

- [Architecture boundaries](ARCHITECTURE.md)
- [Product specification](docs/product-specs/db-relay.md)
- [Connector contract notes](docs/design-docs/connectors.md)
- [Approved design](docs/superpowers/specs/2026-07-31-db-relay-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-31-db-relay.md)

## Workspace Layout

- `src/` contains the sandboxed React renderer and renderer tests.
- `electron/preload.ts` exposes the named, typed IPC allowlist to the renderer.
- `electron/main.ts` composes the main-process application, persistence, and connector services.
- `electron/` contains main-process domain, application, connector, infrastructure, IPC, and architecture tests.
- `docs/` records product decisions and executable plans.

## Required Checks

Run all of these before submitting a change:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

Keep behavior test-first. Current connection passwords are stored as plaintext in the local SQLite database, so treat that database as sensitive. The renderer receives only a same-length `passwordMask`; do not expose raw passwords, bind values, or source rows over IPC, in logs, or in history.

Preview-only source-row handling: `preview_flow_step` is the sole transient source-row exception. Source rows never enter logs, SQLite, history, or other DTOs, and closing preview clears renderer state. Generic SQL remains prohibited; passwords, credentials, and target bind values remain excluded from renderer and history surfaces.

Run `pnpm vitest run electron/ipc/architecture.test.ts` when changing renderer, preload, IPC, connector, or infrastructure boundaries. The structural tests protect the Electron process boundary and prohibit generic SQL commands.

The Oracle integration test is opt-in. Set `DB_RELAY_ORACLE_TEST_URL` to `oracle://user:password@host:port/SID`, using URL encoding for reserved characters, before running `pnpm vitest run electron/connectors/oracle.integration.test.ts`. It is skipped when the variable is absent.
