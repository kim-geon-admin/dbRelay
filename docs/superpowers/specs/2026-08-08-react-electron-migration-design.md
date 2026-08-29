# React + Electron Migration Design

**Status:** Approved  
**Date:** 2026-08-08  
**Scope:** Replace the Tauri/Rust desktop runtime with React + Electron while preserving the existing DB Relay functionality and UI. Use `oracledb` version `^6.2.0` for Oracle connections.

## Goals

- Preserve the existing React UI, routes, styling, visible copy, command DTO contracts, and migration-flow behavior.
- Reuse the existing product specification, connector notes, Rust implementation, Rust test scenarios, React tests, and the approved plaintext-password masking design as the behavioral source of truth.
- Replace the Tauri command boundary with Electron IPC and replace the Rust core with Node/TypeScript main-process services.
- Use only `oracledb@^6.2.0` for production Oracle database connectivity.
- Produce a Windows Electron installer and remove Tauri/Rust production dependencies and build steps.

## Non-Goals

- No redesign of the React UI or changes to visible product behavior.
- No new connector types, scheduling, sharing, automatic flow execution, or SQL-generation features.
- No optional Oracle Thick-mode feature. Electron uses node-oracledb Thin mode by default.
- No change to the current plaintext-password storage and mask-display behavior.

## Existing Sources to Reuse

- `src/`: React UI, CSS, hash routes, DTO typings, and React Testing Library tests.
- `src-tauri/src/domain/`: mapping, source/target SQL validation, run-state transitions, and secret-masking behavior.
- `src-tauri/src/application/`: connection, flow, run, recovery, and history rules.
- `src-tauri/src/infrastructure/sqlite.rs`: SQLite schema, data migration, persistence constraints, and safe history projection.
- `src-tauri/src/connectors/oracle.rs`: Oracle connector contract, named-bind behavior, SID handling, error normalization, and test cases.
- `docs/product-specs/db-relay.md`, `docs/design-docs/connectors.md`, and the latest plaintext-password masking design: accepted behavior and security constraints.
- The current uncommitted changes in `feature/db-relay`: latest UI, domain, test, and style updates. They become the migration baseline in this worktree before Electron-specific changes.

## Architecture

```text
React renderer
  -> typed invokeCommand() facade
  -> window.dbRelay (preload contextBridge allowlist)
  -> Electron IPC handlers (main process)
  -> TypeScript application services
       -> domain rules and ports
       -> SQLite repository / credential resolver
       -> OracleConnector (oracledb@^6.2.0)
```

### Renderer

The existing React files remain the renderer application. `src/lib/tauri.ts` is replaced or renamed with an Electron-backed implementation that preserves the existing typed `invokeCommand()` interface, so feature components retain their current behavior. The renderer exposes no Node.js, database, filesystem, or credential APIs.

### Preload and IPC

Electron runs with `contextIsolation: true` and `nodeIntegration: false`. The preload script exposes a single, typed `window.dbRelay.invoke(command, request)` bridge. It permits only the current ten application commands:

- `list_connections`, `save_connection`, `update_connection`, `disable_connection`, `test_connection`
- `list_flows`, `save_flow`, `duplicate_flow`
- `start_run`, `recover_run`, `list_run_history`

The main process validates the command allowlist and delegates to the corresponding service. No generic SQL IPC command is introduced.

### Main-process services

TypeScript modules retain the existing responsibility boundaries:

- Domain: DTO types, SQL lexical validation, named-bind extraction/mapping, run-state transitions, and sensitive-text masking.
- Application: connection settings, flow management, migration execution, recovery, and history projection.
- Infrastructure: SQLite schema/migrations and local persistence.
- Connector: a `DatabaseConnector` contract and an Oracle implementation. Migration execution depends only on the contract, not `oracledb` types.

The existing all-or-nothing and commit-successes policies, preflight validation, safe run-history projection, and recovery choices remain unchanged.

## Storage and Security

The latest accepted behavior is the plaintext-password masking design. New or replacement passwords are stored in local SQLite as `plaintextPassword`; command responses and React state receive only a same-length `passwordMask`. Existing Keyring records remain readable for compatibility as described by that design, but no UI or feature behavior is altered during this migration.

Passwords, raw source rows, SQL bind values, and complete connection strings must never appear in IPC responses, history rows, renderer logs, or safe error messages. Main-process errors are normalized to the existing `{ code, message, retryable }` form after sensitive values are masked.

## Oracle Connector

`oracledb@^6.2.0` runs only in Electron's main process. Thin mode is the default and needs no Oracle Client installation. The existing SID field is mapped to an Oracle connect descriptor containing `CONNECT_DATA/SID`; the UI and persisted profile field retain their current SID behavior.

The connector:

- opens independent source and target connections;
- executes source queries and maps rows by case-insensitive column name;
- runs target named-bind batches with `executeMany()`;
- commits or rolls back the target transaction according to the existing policy;
- preserves native Oracle errors as masked `ORA-xxxxx` codes where applicable; and
- closes every connection on success, failure, and recovery paths.

## Tests and Packaging

- Keep the existing renderer tests, changing only the transport mock from Tauri invocation to preload IPC.
- Translate the current Rust unit/integration scenarios into TypeScript tests with the same names and assertions where practical: mapping, run state, recovery, persistence migrations, secret masking, connector contract, and IPC architecture boundaries.
- Use a fake connector/session for normal test runs. Keep the real Oracle integration test opt-in via an environment-supplied disposable database URL.
- Use Electron with the existing Vite renderer, `electron-builder`, and `@electron/rebuild` for Windows packaging. Native dependencies such as `oracledb` and the SQLite driver are rebuilt for Electron and unpacked from ASAR.
- Completion requires `pnpm lint`, `pnpm test`, renderer production build, Electron main/preload build, and Windows package build to pass. Tauri/Rust files, dependencies, scripts, workflows, and documentation references are removed or updated.
