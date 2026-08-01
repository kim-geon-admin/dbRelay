# DB Relay

DB Relay is a Windows desktop application for running reusable, ordered Oracle migration flows. A flow reads source rows and applies named-bind target upserts using either `all_or_nothing` or `commit_successes` transaction handling.

## Prerequisites

- Windows 10 or later with WebView2 Runtime installed.
- Node.js 22 and pnpm 10.
- Rust stable with the `rustfmt` and `clippy` components.
- Visual Studio Build Tools with the Desktop development with C++ workload and Windows SDK, as required by Tauri on Windows.
- Oracle Client libraries reachable by `oracle-rs` when connecting to Oracle.

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

Connection metadata and flow definitions are stored locally in SQLite. Passwords and tokens are stored separately in Windows Credential Manager under the stable connection ID; SQLite stores only the credential reference. Credentials, bind values, and source rows are never returned by the command API or recorded in run history.

## Verification

Run the release checks from the repository root:

```powershell
pnpm lint
pnpm test
pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

The Oracle integration test is intentionally ignored unless a disposable Oracle instance is supplied. Set `DB_RELAY_ORACLE_TEST_URL` only in your shell or CI secret, then run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test oracle_contract -- --ignored
```

The URL must identify an isolated test database because the test creates and changes disposable tables. Do not commit this URL or any database credential.

## First-release exclusions

- Scheduled or background execution and multi-user flow sharing.
- Parallel or distributed execution and large-volume retry orchestration.
- Production connectors other than Oracle.
- Automatic SQL generation, data-transformation scripting, and schema migration tooling.
