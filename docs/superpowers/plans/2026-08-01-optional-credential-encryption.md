# Optional Credential Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let each connection use default Windows Credential Manager storage or deliberate local plaintext storage that can be shown in the editor.

**Architecture:** Add a storage discriminator and optional plaintext password to the connection profile and SQLite persistence. Settings and run services resolve either source to the existing connector-secret type. The command response returns a password exclusively for plaintext profiles. React exposes the mode with one clear checkbox and removes the legacy source-read-only policy.

**Tech Stack:** Rust, Tauri 2, rusqlite, Windows keyring crate, React, TypeScript, Vitest, pnpm.

## Global Constraints

- New and migrated connections default to keyring.
- Keyring connection DTOs never return a password or credential reference; plaintext DTOs deliberately return their password.
- A mode change requires a supplied password; write the replacement before deleting a prior keyring entry.
- The legacy source_read_only DB column may remain but is no longer read, returned, rendered, or enforced.
- Run history, SQL, bind values, source rows, and connector diagnostics remain protected.
- Preserve unrelated user changes in src/styles/global.css, src/features/flows/FlowEditor.tsx, and src/features/flows/FlowLibrary.test.tsx.

---

### Task 1: Add credential-mode persistence

**Files:**
- Modify: src-tauri/src/domain/model.rs
- Modify: src-tauri/src/infrastructure/sqlite.rs
- Test: src-tauri/tests/sqlite.rs

**Interfaces:**
- Produces CredentialStorage::{Keyring, Plaintext}, serialized as keyring and plaintext.
- Produces ConnectionProfile with credential_storage: CredentialStorage and plaintext_password: Option<String>, with no source_read_only.
- Produces SQLite columns credential_storage TEXT NOT NULL DEFAULT 'keyring' and nullable plaintext_password TEXT.

- [ ] **Step 1: Write failing persistence tests**

~~~rust
#[test]
fn plaintext_connection_round_trips_its_explicit_password() {
    let store = SqliteStore::in_memory().unwrap();
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile("source", "unused")
    };
    store.save_connection(&profile).unwrap();

    let loaded = store.load_connection("source").unwrap();
    assert_eq!(loaded.credential_storage, CredentialStorage::Plaintext);
    assert_eq!(loaded.plaintext_password.as_deref(), Some("visible-password"));
}

#[test]
fn legacy_connection_schema_defaults_to_keyring_without_plaintext() {
    let store = store_with_legacy_connection_profile_schema();
    let loaded = store.load_connection("legacy").unwrap();
    assert_eq!(loaded.credential_storage, CredentialStorage::Keyring);
    assert_eq!(loaded.plaintext_password, None);
}
~~~

- [ ] **Step 2: Run tests and observe the expected red state**

Run: cargo test --manifest-path src-tauri/Cargo.toml --test sqlite plaintext_connection_round_trips_its_explicit_password legacy_connection_schema_defaults_to_keyring_without_plaintext

Expected: FAIL because the enum, fields, and migration do not exist.

- [ ] **Step 3: Implement the minimal model and migration**

~~~rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStorage { Keyring, Plaintext }

pub struct ConnectionProfile {
    // existing connection metadata
    pub credential_ref: String,
    pub credential_storage: CredentialStorage,
    pub plaintext_password: Option<String>,
    pub enabled: bool,
}
~~~

Add both fields to all connection INSERT/UPDATE/SELECT/row mappings. The initial schema includes both columns; existing databases gain them only when absent. Preserve credential_ref for compatibility but do not require a live keyring value for plaintext rows. Remove source_read_only from the Rust model and persistence projections while leaving the old SQLite column intact.

- [ ] **Step 4: Verify the persistence suite is green**

Run: cargo test --manifest-path src-tauri/Cargo.toml --test sqlite

Expected: PASS, including new round-trip and migration coverage.

- [ ] **Step 5: Commit**

~~~powershell
git add src-tauri/src/domain/model.rs src-tauri/src/infrastructure/sqlite.rs src-tauri/tests/sqlite.rs
git commit -m "feat: persist optional plaintext credentials"
~~~

### Task 2: Resolve and expose only the selected credential mode

**Files:**
- Modify: src-tauri/src/application/settings_service.rs
- Modify: src-tauri/src/application/migration_runner.rs
- Modify: src-tauri/src/commands/connections.rs
- Modify: src-tauri/tests/sqlite.rs
- Modify: src-tauri/tests/commands.rs
- Modify: src/lib/tauri.ts

**Interfaces:**
- Consumes the profile fields from Task 1.
- Produces command fields credentialStorage and optional password.
- Produces connector-secret resolution from plaintext data when mode is Plaintext, otherwise from the keyring.

- [ ] **Step 1: Write failing command and service tests**

~~~rust
#[test]
fn plaintext_connection_response_serializes_its_password() {
    let response = ConnectionResponse::from(ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile_with_secret_reference()
    });

    let json = serde_json::to_string(&response).unwrap();
    assert!(json.contains("visible-password"));
    assert!(json.contains("plaintext"));
}

#[test]
fn keyring_connection_response_omits_password_and_reference() {
    let json = serde_json::to_string(&ConnectionResponse::from(profile_with_secret_reference())).unwrap();
    assert!(!json.contains("password"));
    assert!(!json.contains("credential_ref"));
}
~~~

Add a service test with a Plaintext profile and recording credential store that proves test_connection opens the connector without calling CredentialStore::resolve.

- [ ] **Step 2: Run tests and observe red state**

Run: cargo test --manifest-path src-tauri/Cargo.toml --test commands plaintext_connection_response_serializes_its_password keyring_connection_response_omits_password_and_reference; cargo test --manifest-path src-tauri/Cargo.toml --test sqlite plaintext_connection_test_does_not_read_the_keyring

Expected: FAIL because command DTOs have no storage mode/password and all resolution reads the keyring.

- [ ] **Step 3: Implement mode-aware saves, transitions, and responses**

Change create/update requests to accept credential_storage and a password. New keyring saves store into a versioned account before metadata. New plaintext saves persist Some(password). Updates preserve a password in its current mode when absent, but reject a mode change without a nonempty password.

For keyring-to-plaintext, persist plaintext metadata before deleting the old keyring value. For plaintext-to-keyring, write the new keyring entry before metadata clears plaintext_password; delete that new entry when metadata persistence fails. In both SettingsService and MigrationRunner, resolve plaintext via ResolvedSecret::new(profile.plaintext_password); preserve error masking by supplying the resolved credential value.

Project credential_storage always and password: Some(...) only for plaintext connections. Keyring response values remain absent. Mirror exact camelCase fields in the typed src/lib/tauri.ts command maps.

- [ ] **Step 4: Verify the service and command tests are green**

Run: cargo test --manifest-path src-tauri/Cargo.toml --test commands; cargo test --manifest-path src-tauri/Cargo.toml --test sqlite; cargo test --manifest-path src-tauri/Cargo.toml --test migration_runner

Expected: PASS; both modes can connect/run, and only plaintext responses contain a password.

- [ ] **Step 5: Commit**

~~~powershell
git add src-tauri/src/application/settings_service.rs src-tauri/src/application/migration_runner.rs src-tauri/src/commands/connections.rs src-tauri/tests/sqlite.rs src-tauri/tests/commands.rs src/lib/tauri.ts
git commit -m "feat: support selectable credential storage"
~~~

### Task 3: Replace the unclear UI and remove source-read-only enforcement

**Files:**
- Modify: src/features/connections/connections.types.tsx
- Modify: src/features/connections/connections.api.tsx
- Modify: src/features/connections/ConnectionForm.tsx
- Test: src/features/connections/ConnectionForm.test.tsx
- Modify: src/features/flows/FlowEditor.tsx
- Test: src/features/flows/FlowEditor.test.tsx
- Modify: src/features/run/RunDashboard.tsx
- Test: src/features/run/RunDashboard.test.tsx
- Modify: src-tauri/src/application/flow_service.rs
- Modify: src-tauri/src/application/migration_runner.rs
- Test: src-tauri/tests/migration_runner.rs

**Interfaces:**
- Consumes Connection with credentialStorage: "keyring" | "plaintext" and optional password.
- Produces a connection save request with the selected mode.
- Produces flow/run validation requiring enabled and distinct profiles, but not the legacy source-read-only flag.

- [ ] **Step 1: Write failing React and policy tests**

~~~tsx
it("defaults to encrypted storage and removes the legacy checkbox copy", () => {
  render(<ConnectionForm onSave={vi.fn()} />);
  expect(screen.getByLabelText("Encrypt password storage")).toBeChecked();
  expect(screen.queryByLabelText("Source account is read-only")).toBeNull();
  expect(screen.queryByText("leave blank to keep existing")).toBeNull();
});

it("shows a plaintext connection password in an unmasked editor field", () => {
  render(<ConnectionForm connection={{ ...connection, credentialStorage: "plaintext", password: "visible-password" }} onSave={vi.fn()} />);
  expect(screen.getByLabelText("Password")).toHaveValue("visible-password");
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
});
~~~

Add a migration_runner or FlowService test with a source connection whose old database value is unchecked and assert that saving/running its valid flow succeeds.

- [ ] **Step 2: Run tests and observe red state**

Run: pnpm vitest run src/features/connections/ConnectionForm.test.tsx src/features/flows/FlowEditor.test.tsx src/features/run/RunDashboard.test.tsx; cargo test --manifest-path src-tauri/Cargo.toml --test migration_runner

Expected: FAIL because the old checkbox/copy still render, plaintext values are cleared, and flow/run still require source-read-only.

- [ ] **Step 3: Implement the form, API, and policy changes**

Remove sourceReadOnly from frontend types, form state, command request bodies, and editor UI. Add credentialStorage and optional password; default new forms to keyring. Render exactly one checkbox, labelled Encrypt password storage, directly above Password. A plaintext connection uses a populated input type text; a keyring connection uses a blank input type password. Remove the legacy hint, and retain plaintext value after save.

Remove source-read-only filtering and validation from FlowEditor, source-read-only checks from the dashboard preflight predicate, FlowService, and MigrationRunner. Keep distinct-connection and enabled-connection guards.

- [ ] **Step 4: Verify targeted UI and policy tests are green**

Run: pnpm vitest run src/features/connections/ConnectionForm.test.tsx src/features/flows/FlowEditor.test.tsx src/features/run/RunDashboard.test.tsx; cargo test --manifest-path src-tauri/Cargo.toml --test migration_runner

Expected: PASS; the sole checkbox controls storage, plaintext passwords are visibly editable, and unchecked legacy state never blocks valid flows.

- [ ] **Step 5: Commit**

~~~powershell
git add src/features/connections src/features/flows/FlowEditor.tsx src/features/flows/FlowEditor.test.tsx src/features/run/RunDashboard.tsx src/features/run/RunDashboard.test.tsx src-tauri/src/application/flow_service.rs src-tauri/src/application/migration_runner.rs src-tauri/tests/migration_runner.rs
git commit -m "feat: expose selected plaintext connection passwords"
~~~

### Task 4: Align documentation and verify the application

**Files:**
- Modify: README.md
- Modify: ARCHITECTURE.md
- Modify: docs/product-specs/db-relay.md

**Interfaces:**
- Consumes final behavior from Tasks 1–3.
- Produces accurate operator guidance on default keyring versus deliberate plaintext storage.

- [ ] **Step 1: Establish stale documentation with a search**

Run: rg -n "source-read-only attestation|Passwords and tokens are stored separately|never return passwords" README.md ARCHITECTURE.md docs/product-specs/db-relay.md

Expected: matching statements that conflict with the changed behavior.

- [ ] **Step 2: Update affected documentation**

Describe keyring as the default, plaintext as a user-selected SQLite storage mode whose password is returned to the editor, and source read-only access as an operational recommendation rather than an application gate. Retain the history/SQL/bind/source-row protection statements.

- [ ] **Step 3: Verify docs and all required checks**

Run: rg -n "source-read-only attestation|never return passwords" README.md ARCHITECTURE.md docs/product-specs/db-relay.md; pnpm test; pnpm lint; cargo test --manifest-path src-tauri/Cargo.toml; cargo test --manifest-path src-tauri/Cargo.toml --test architecture; pnpm tauri build

Expected: the stale-text search returns no matches and every test/lint/build command exits 0. Report any unavailable external prerequisite instead of claiming a successful build.

- [ ] **Step 4: Commit**

~~~powershell
git add README.md ARCHITECTURE.md docs/product-specs/db-relay.md
git commit -m "docs: explain optional plaintext credential storage"
~~~
