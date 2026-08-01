# DB Relay Architecture

## Dependency Direction

The only allowed dependency direction is:

```text
React UI -> Tauri command DTOs -> application services -> domain ports
                                         ^                    ^
                         infrastructure implementations ------|
                         connector implementations -----------|
```

- The domain depends only on Rust standard-library types and its own pure rules.
- Application services depend on domain ports, never concrete connectors, SQLite, or credential implementations.
- Infrastructure and connectors implement application/domain ports and may depend on external drivers.
- The UI depends only on Tauri command DTOs; it must not import connector or credential implementations.
- Adding a database requires a `DatabaseConnector` implementation and registry entry, not changes to `MigrationRunner` or the UI.

## Boundary Rules

Secrets reside only in Windows Credential Manager. SQLite stores only credential references and metadata. Commands return safe DTOs and never return passwords, tokens, bind values, or source rows.

## Enforced Architecture Checks

`src-tauri/tests/architecture.rs` protects two release boundaries:

- Tauri commands may expose only typed application operations; they must not expose generic arbitrary-SQL execution.
- Domain modules must not depend on infrastructure modules.

The Windows CI workflow runs these checks together with Rust formatting, Clippy, all Rust tests, and the frontend lint, tests, and production builds.
