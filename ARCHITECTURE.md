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

Secrets reside only in Windows Credential Manager. SQLite stores only credential references and metadata. Commands return safe DTOs and never return passwords, tokens, SQL text, bind values, or source rows. Run-history persistence stores a safe recovery binding (flow ID/version, connection IDs, and non-secret configuration fingerprints), then reloads and verifies the live flow/profile before recovery rather than serializing the executable flow or credential references.

The Oracle connector maps `DATE` and timezone-free `TIMESTAMP` into structured domain values and uses oracle-rs typed batch binds. Capability preflight rejects ambiguous textual timestamps and timestamps with timezone offsets before target `begin`, because oracle-rs 0.1.7 writes those batch binds as plain timestamps.

Oracle source sessions have no application-enforced read-only mode: oracle-rs 0.1.7 does not expose a supported read-only transaction/session API. A source profile therefore carries an explicit read-only-principal attestation, checked when saving and running a flow. Deployment must enforce it with a dedicated Oracle principal granted only the required `SELECT` privileges. SQL lexical validation is supplemental and cannot establish that a `SELECT` invoking user-defined functions is side-effect free.

## Enforced Architecture Checks

`src-tauri/tests/architecture.rs` protects two release boundaries:

- Tauri commands may expose only typed application operations; they must not expose generic arbitrary-SQL execution.
- Domain modules must not depend on infrastructure modules.

The Windows CI workflow runs these checks together with Rust formatting, Clippy, all Rust tests, and the frontend lint, tests, and production builds.
