# DB Relay Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the failure paths discovered during final review so an invalid flow, a failed rollback, a restart during recovery, or a duplicate invocation cannot silently corrupt or misrepresent a migration.

**Architecture:** Put statement-policy enforcement and zero-row validation behind the database port so both command and runner paths are protected. Persist recovery/transaction uncertainty explicitly rather than relabelling it as successful rollback. Make persisted run identity and saved-flow updates collision/concurrency safe, and expose a stable, safe desktop DTO.

**Tech Stack:** Rust 2021, Tauri 2, rusqlite, oracle-rs, React/TypeScript, Vitest.

## Global Constraints

- Never read, log, serialize, or store a database password outside the OS keyring.
- Source statements must be read-only `SELECT`/`WITH` queries; target statements must be the connector's supported UPSERT form (Oracle `MERGE`); reject DDL, PL/SQL, transaction control, and anonymous bind syntax before any target transaction opens.
- A failed or indeterminate rollback must remain visibly unsafe and must not allow automatic retry/continue.
- Preserve the existing all-or-nothing and committed-step recovery behaviours for valid flows.
- Keep Oracle integration tests opt-in through `DB_RELAY_ORACLE_TEST_URL`; do not inspect `.env`.

---

### Task 14: Enforce statement policy and zero-row preflight

**Files:**
- Modify: `src-tauri/src/domain/model.rs`, `src-tauri/src/domain/mapping.rs`, `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/application/ports.rs`, `src-tauri/src/application/migration_runner.rs`, `src-tauri/src/commands/flows.rs`
- Modify: `src-tauri/src/connectors/oracle.rs`
- Test: `src-tauri/tests/mapping.rs`, `src-tauri/tests/migration_runner.rs`, `src-tauri/tests/commands.rs`, `src-tauri/tests/oracle_contract.rs`

**Interfaces:**
- Produces `validate_source_statement(sql: &str) -> Result<(), ValidationError>` and `validate_target_statement(kind: DbKind, sql: &str) -> Result<(), ValidationError>`.
- Extends `RowSet` with `columns: Vec<String>` so validation does not depend on rows being returned.

- [ ] **Step 1: Write failing policy and metadata tests**

```rust
assert!(validate_source_statement("SELECT id FROM t").is_ok());
assert!(validate_source_statement("DELETE FROM t").is_err());
assert!(validate_target_statement(DbKind::Oracle, "MERGE INTO t USING dual ON (1=1) WHEN MATCHED THEN UPDATE SET x=1").is_ok());
assert!(validate_target_statement(DbKind::Oracle, "TRUNCATE TABLE t").is_err());
```

Add runner tests proving a zero-row query with a missing alias is rejected before `begin`, and a target statement with `:1` is rejected before `begin`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support --test mapping --test migration_runner --test commands --test oracle_contract`

Expected: FAIL because no statement validator or metadata preflight exists.

- [ ] **Step 3: Implement lexical policy and connector metadata**

Strip SQL comments and quoted literals before taking the first keyword; accept only `SELECT`/`WITH` for source and `MERGE` for Oracle target. Reject semicolon-separated statements, `BEGIN`/`DECLARE`, DDL/DCL/TCL keywords, and numeric bind tokens. Populate `RowSet::columns` from Oracle query metadata and from fakes; map aliases against `columns` even when `rows` is empty. Invoke validation when saving a flow and again in runner preflight.

- [ ] **Step 4: Run focused and full Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support`

Expected: PASS, with new invalid-statement and zero-row tests green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src-tauri/tests
git commit -m "fix: enforce safe migration statement policies"
```

### Task 15: Make recovery and rollback failures durable and truthful

**Files:**
- Modify: `src-tauri/src/domain/run_state.rs`, `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/application/ports.rs`, `src-tauri/src/application/migration_runner.rs`
- Modify: `src-tauri/src/infrastructure/sqlite.rs`
- Test: `src-tauri/tests/run_state.rs`, `src-tauri/tests/migration_runner.rs`, `src-tauri/tests/sqlite.rs`

**Interfaces:**
- Produces `RunStatus::RecoveryPending { failed_step }` and `RunStatus::InDoubt { step, reason }`.
- Adds an atomic repository transition that records a requested recovery action without making the run unrecoverable before external work starts.

- [ ] **Step 1: Write failing state and runner tests**

```rust
assert!(matches!(run.status(), RunStatus::InDoubt { .. }));
assert!(runner.recover(run_id, skip).await.is_err());
```

Cover: rollback failure becomes `InDoubt`; a simulated crash after reserving Skip/Edit remains `RecoveryPending` and can be safely resumed or returned to AwaitingRecovery; invalid Edit candidate never overwrites the saved flow.

- [ ] **Step 2: Run recovery tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support --test run_state --test migration_runner --test sqlite`

Expected: FAIL because rollback errors are discarded and recovery immediately becomes `Running`/terminal.

- [ ] **Step 3: Implement durable state machine transitions**

Make rollback return an error into a sanitized `InDoubt` state. For Skip/Edit, atomically reserve `RecoveryPending` with binding/version/action, then preflight external work; only persist a changed flow after its candidate passes preflight. On process restart, convert an unstarted pending reservation to AwaitingRecovery and require the user to choose again; never execute it automatically. Persist the pre-commit checkpoint before target commit and preserve a `commit_pending`/indeterminate record if persistence after commit fails.

- [ ] **Step 4: Run recovery and persistence suites**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support --test run_state --test migration_runner --test sqlite`

Expected: PASS with rollback, pending-recovery, invalid-edit, and post-commit checkpoint coverage.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src-tauri/tests
git commit -m "fix: preserve indeterminate migration recovery states"
```

### Task 16: Harden persistence, invocation identity, and desktop contract

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/flows.rs`, `src-tauri/src/commands/runs.rs`, `src-tauri/src/commands/history.rs`
- Modify: `src-tauri/src/application/settings_service.rs`, `src-tauri/src/application/ports.rs`, `src-tauri/src/infrastructure/sqlite.rs`, `src-tauri/Cargo.toml`
- Modify: `src/lib/tauri.ts`, `src/features/run/RunDashboard.tsx`, `src/features/run/RecoveryDialog.tsx`
- Test: `src-tauri/tests/commands.rs`, `src-tauri/tests/sqlite.rs`, `src/features/run/*.test.tsx`

**Interfaces:**
- Produces opaque UUID run IDs and insert-only initial run persistence.
- Produces `RunEventDto` using `{ type: "step_failed", error: { type: "connector", detail: ... } }`, matching Rust serialization exactly.

- [ ] **Step 1: Write failing tests**

```rust
assert_ne!(runner.start(flow.clone()).await?.run_id, runner.start(flow).await?.run_id);
assert!(save_stale_flow_version().is_err());
```

Add UI test receiving the exact `RunEvent` tagged-union JSON (`type`/`detail`) and asserting the Oracle code/message is visible. Add a command test proving a source and target with the same connection ID is rejected.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support --test commands --test sqlite --test migration_runner; pnpm test -- src/features/run`

Expected: FAIL because timestamp IDs, blind upserts, and the TypeScript error shape remain.

- [ ] **Step 3: Implement safe persistence and UI behaviour**

Use `uuid::Uuid::new_v4()` for runs and make initial run creation `INSERT` that reports a collision. Initialize `SqliteStore` at a created Tauri app-data absolute path. Add expected-version compare-and-swap for flow updates, force a monotonic server version, reject identical source/target IDs, and use a compensating delete/versioned keyring account when credential metadata persistence fails. Update TypeScript to the tagged Rust wire shape and disable Run while an invocation is in flight.

- [ ] **Step 4: Run focused then full UI/Rust tests**

Run: `pnpm test; pnpm lint; pnpm build; cargo test --manifest-path src-tauri/Cargo.toml --features test-support`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src src-tauri
git commit -m "fix: harden desktop migration persistence contract"
```

### Task 17: Oracle typed values, history detail, and release verification

**Files:**
- Modify: `src-tauri/src/domain/model.rs`, `src-tauri/src/connectors/oracle.rs`, `src-tauri/src/commands/history.rs`, `src-tauri/src/infrastructure/sqlite.rs`
- Modify: `src/lib/tauri.ts`, `src/features/history/*`, `README.md`, `ARCHITECTURE.md`
- Test: `src-tauri/tests/oracle_contract.rs`, `src-tauri/tests/sqlite.rs`, `src/features/history/*.test.tsx`

**Interfaces:**
- Supports a lossless Oracle temporal bind representation or fails it before execution with an explicit user-visible preflight capability error; it must never start a target transaction then discover an unsupported timestamp.
- History exposes only safe flow ID/version, started/ended timestamps, policy, step status, recovery decisions, and sanitized connector code/message.

- [ ] **Step 1: Write failing typed-value and history tests**

```rust
assert_eq!(preflight_timestamp_flow().await.unwrap_err().code(), "BIND_TYPE_UNSUPPORTED");
assert_eq!(history_entry.flow_version, 3);
assert!(history_entry.error_message.contains("ORA-"));
```

Add an opt-in Oracle round-trip test when the driver API supports a typed temporal bind; otherwise test the preflight rejection before `begin`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --features test-support --test oracle_contract --test sqlite`

Expected: FAIL because timestamp rejection happens during target execution and history drops safe details.

- [ ] **Step 3: Implement the supported safe path**

Inspect oracle-rs 0.1.7 binding support. If it has a typed temporal bind, carry it in `Value` and bind it losslessly; if it does not, have connector capability preflight reject a timestamp step before `begin`. Persist and map safe audit fields without SQL text, bind values, passwords, or raw driver errors. Render them in history.

- [ ] **Step 4: Verify the release candidate**

Run: `pnpm lint; pnpm test; pnpm build; cargo fmt --check --manifest-path src-tauri/Cargo.toml; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-support -- -D warnings; cargo test --manifest-path src-tauri/Cargo.toml --features test-support; pnpm tauri build`

Expected: PASS; Oracle live test remains ignored unless `DB_RELAY_ORACLE_TEST_URL` is supplied.

- [ ] **Step 5: Commit**

```bash
git add src src-tauri README.md ARCHITECTURE.md
git commit -m "fix: complete safe migration auditability"
```

### Post-review closure

Final whole-branch review identified and resolved additional boundary conditions in commit `057191b`: unsupported Oracle values are rejected when bound rather than stringified; execution diagnostics exclude source/bind values; credential rotation persists the new key reference before deleting the old one; interrupted commit records receive a terminal timestamp; and legacy flows are revalidated for distinct source/target profiles. Source queries require an explicit read-only profile attestation and a database principal with SELECT-only privileges; the Oracle driver does not expose an application-level read-only session switch.
