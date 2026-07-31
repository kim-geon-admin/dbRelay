# DB Relay Contributor Map

DB Relay is a Windows desktop application built with Tauri 2, Rust, React, TypeScript, and pnpm.

## Read First

- [Architecture boundaries](ARCHITECTURE.md)
- [Product specification](docs/product-specs/db-relay.md)
- [Connector contract notes](docs/design-docs/connectors.md)
- [Approved design](docs/superpowers/specs/2026-07-31-db-relay-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-31-db-relay.md)

## Workspace Layout

- `src/` contains the React UI and UI tests.
- `src-tauri/src/` contains the Rust core and Tauri command boundary.
- `src-tauri/tests/` contains Rust integration and architecture tests.
- `docs/` records product decisions and executable plans.

## Required Checks

Run all of these before submitting a change:

```powershell
pnpm test
pnpm lint
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

Keep behavior test-first. Do not expose credentials, bind values, or source rows in UI data, logs, or history.
