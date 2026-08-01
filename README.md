# DB Relay

DB Relay is a Windows desktop application for running reusable, ordered Oracle migration flows. A flow reads source rows and applies named-bind target upserts using either `all_or_nothing` or `commit_successes` transaction handling.

## Prerequisites

- Windows 10 or later with WebView2 Runtime installed.
- Node.js 22 and pnpm 10.
- Rust stable with the `rustfmt` and `clippy` components.
- Visual Studio Build Tools with the Desktop development with C++ workload and Windows SDK, as required by Tauri on Windows.
- Network access to an Oracle database server, plus its connection details and valid credentials.

Install dependencies and start the desktop application:

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

Build a distributable application with:

```powershell
pnpm tauri build
```

## Credentials and local data

Connection metadata and flow definitions are stored locally in SQLite. Passwords and tokens are stored separately in Windows Credential Manager under the stable connection ID; SQLite stores only the credential reference. Credentials, SQL text, bind values, and source rows are never returned by the command API or recorded in run history. History instead records the flow ID/version, start/end timestamps, transaction policy, step statuses, recovery decisions, and sanitized connector code/message/retry metadata.

Oracle `DATE` and timezone-free `TIMESTAMP` source values are carried as typed Oracle binds. Ambiguous textual timestamps and timestamps with an offset are rejected during preflight before a target transaction opens; `oracle-rs` 0.1.7 batch binding does not preserve the latter's timezone representation.

## Source-account safety policy

Every source connection must be explicitly marked **Source account is read-only** before a flow can be saved or run. This is an operator attestation, not a driver-enforced session mode: `oracle-rs` 0.1.7 exposes query, execute, commit, and rollback operations but no supported API for an Oracle read-only session or `SET TRANSACTION READ ONLY`. Configure the selected Oracle source principal itself with only the minimum `SELECT` grants required by the flow, and do not grant DML, DDL, transaction-control, or executable routine privileges that could mutate data.

The application's `SELECT`/`WITH` validation is a defense-in-depth syntax check only. It cannot prove that an Oracle function called inside a `SELECT` has no side effects; database principal privileges are the enforcement boundary.

## Verification

Run the release checks from the repository root:

```powershell
pnpm lint
pnpm test
pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --features test-support
pnpm tauri build
```

The Rust test command enables `test-support`, covering the migration-runner and SQLite integration tests that are gated behind that feature. The Oracle integration test is intentionally ignored unless a disposable Oracle instance is supplied. Set `DB_RELAY_ORACLE_TEST_URL` only in your shell or CI secret, then run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test oracle_contract -- --ignored
```

The URL must identify an isolated test database because the test creates and changes disposable tables. Do not commit this URL or any database credential.

## First-release exclusions

- Scheduled or background execution and multi-user flow sharing.
- Parallel or distributed execution and large-volume retry orchestration.
- Production connectors other than Oracle.
- Automatic SQL generation, data-transformation scripting, and schema migration tooling.
