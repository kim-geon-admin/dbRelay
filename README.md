# DB Relay

DB Relay is a Windows desktop application for running reusable, ordered Oracle migration flows. A flow reads source rows and applies named-bind target upserts using either `all_or_nothing` or `commit_successes` transaction handling.

## Prerequisites

- Windows 10 or later.
- Node.js 22 and pnpm 10.
- Visual Studio Build Tools with the Desktop development with C++ workload and Windows SDK, as required to rebuild native Node modules.
- Network access to an Oracle database server, plus its connection details and valid credentials.

Install dependencies and start the desktop application:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Build a distributable application with:

```powershell
pnpm package
```

## Credentials and local data

Connection metadata, flow definitions, and current connection passwords are stored locally in SQLite. Password storage is plaintext, so protect the local database as a sensitive file. When editing a saved connection, the password field displays `*` characters matching the password length, never the password itself. The Electron main process does not send plaintext passwords, credential references, bind values, source rows, or raw execution inputs to the renderer or record them in run history.

Oracle connectivity runs only in the Electron main process through `oracledb@^6.2.0`. Oracle `DATE` and timezone-free `TIMESTAMP` source values are carried as typed Oracle binds. Ambiguous textual timestamps and timestamps with an offset are rejected during preflight before a target transaction opens.

## Source-account safety policy

Source connections do not have an application-enforced read-only mode. Configure the selected Oracle source principal itself with only the minimum `SELECT` grants required by the flow, and do not grant DML, DDL, transaction-control, or executable routine privileges that could mutate data.

The application's `SELECT`/`WITH` validation is a defense-in-depth syntax check only. It cannot prove that an Oracle function called inside a `SELECT` has no side effects; database principal privileges are the enforcement boundary.

## Verification

Run the release checks from the repository root:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

The renderer is sandboxed from Node and databases. A context-isolated preload exposes only the typed DB Relay command allowlist; the Electron main process owns IPC validation, SQLite, and Oracle sessions.

The Oracle integration test is opt-in. Set `DB_RELAY_ORACLE_TEST_URL` to `oracle://user:password@host:port/SID`, URL-encoding reserved characters in credentials, and run:

```powershell
pnpm vitest run electron/connectors/oracle.integration.test.ts
```

The test skips when the variable is absent.

After installing dependencies for a new Electron version, rebuild the native modules:

```powershell
pnpm rebuild:native
```

Do not commit database credentials.

## First-release exclusions

- Scheduled or background execution and multi-user flow sharing.
- Parallel or distributed execution and large-volume retry orchestration.
- Production connectors other than Oracle.
- Automatic SQL generation, data-transformation scripting, and schema migration tooling.
