# Plaintext Password Storage and Masked Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save supplied connection passwords as plaintext and show only same-length literal asterisks after loading, while supporting direct in-field replacement.

**Architecture:** Command requests make plaintext profiles by default. The settings service derives a mask from plaintext without serializing it and retains legacy Keyring profiles until a replacement is supplied. The React form selects the loaded mask on focus and replaces it with visibly plaintext user input.

**Tech Stack:** Rust, Tokio, rusqlite, Tauri 2, React 19, TypeScript, Vitest.

## Global Constraints

- Keep Keyring code and existing Keyring records.
- Never add plaintext to `ConnectionResponse`.
- Do not add a checkbox or a separate change-password button.
- A legacy Keyring profile with no replacement stays Keyring-backed.

---

### Task 1: Store newly supplied passwords as plaintext

**Files:**
- Modify: `src-tauri/src/commands/connections.rs:228-268`
- Modify: `src-tauri/src/application/settings_service.rs:47-123`
- Test: `src-tauri/tests/sqlite.rs`

**Interfaces:** `ConnectionRequest::new_profile` and `UpdateConnectionRequest::profile` produce plaintext `ConnectionProfile` values. `SettingsService::update_connection` retains a legacy Keyring profile when no replacement is supplied.

- [ ] **Step 1: Write the failing legacy-preservation test**

```rust
#[tokio::test]
async fn updating_legacy_keyring_metadata_without_a_password_keeps_keyring_storage() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let existing = profile("source", "legacy-secret");
    store.save_connection(&existing).unwrap();
    let requested = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: None,
        ..existing.clone()
    };

    SettingsService::new(store.clone(), Arc::new(RecordingCredentialStore::default()))
        .update_connection(&requested, None).await.unwrap();
    assert_eq!(store.load_connection("source").unwrap().credential_storage, CredentialStorage::Keyring);
}
```

- [ ] **Step 2: Verify the test is red**

Run: `cargo test --features test-support --test sqlite updating_legacy_keyring_metadata_without_a_password_keeps_keyring_storage`

Expected: failure because Keyring-to-plaintext currently requires a replacement.

- [ ] **Step 3: Implement the storage transition**

```rust
credential_storage: CredentialStorage::Plaintext,
plaintext_password: Some(self.secret.clone()),
```

For updates, use `replacement_secret` for `plaintext_password`. In `SettingsService`, when existing storage is Keyring and replacement is absent, restore `updated.credential_storage`, `updated.credential_ref`, and `updated.plaintext_password` from the existing Keyring profile. When replacement exists, persist it as plaintext and do not delete the old Keyring entry.

- [ ] **Step 4: Verify and commit**

Run: `cargo test --features test-support --test sqlite`

Commit: `git commit -m "feat: store supplied connection passwords as plaintext"`

### Task 2: Derive a mask from plaintext

**Files:**
- Modify: `src-tauri/src/application/settings_service.rs:150-162`
- Test: `src-tauri/tests/sqlite.rs`

**Interfaces:** `SettingsService::password_mask(&ConnectionProfile) -> String` returns an asterisk per character in `plaintext_password` for plaintext profiles.

- [ ] **Step 1: Write the failing plaintext-mask test**

```rust
#[tokio::test]
async fn plaintext_credentials_are_projected_as_same_length_asterisks() {
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("secret123".into()),
        ..profile("source", "unused")
    };
    let service = SettingsService::new(
        Arc::new(SqliteStore::in_memory().unwrap()),
        Arc::new(RecordingCredentialStore::default()),
    );
    assert_eq!(service.password_mask(&profile).await, "*********");
}
```

- [ ] **Step 2: Verify the test is red**

Run: `cargo test --features test-support --test sqlite plaintext_credentials_are_projected_as_same_length_asterisks`

Expected: failure because the current method tries Keyring resolution.

- [ ] **Step 3: Implement and verify direct plaintext masking**

```rust
if profile.credential_storage == CredentialStorage::Plaintext {
    return profile.plaintext_password.as_deref()
        .map(|password| "*".repeat(password.chars().count()))
        .unwrap_or_default();
}
```

Run: `cargo test --features test-support --test sqlite plaintext_credentials_are_projected_as_same_length_asterisks`

Expected: pass with nine asterisks.

### Task 3: Focus the mask without clearing it

**Files:**
- Modify: `src/features/connections/ConnectionForm.tsx:42-103`
- Test: `src/features/connections/ConnectionForm.test.tsx:20-31`

**Interfaces:** `Connection.passwordMask` initializes the text input. `ConnectionSaveInput.password` appears only after the form receives a typed or pasted replacement.

- [ ] **Step 1: Write failing focus and direct-edit tests**

```tsx
fireEvent.focus(password);
expect(password).toHaveValue("********");
expect(password.selectionStart).toBe(0);
expect(password.selectionEnd).toBe(8);

fireEvent.change(password, { target: { value: "new-secret" } });
fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: "new-secret" }));
```

- [ ] **Step 2: Verify the form test is red**

Run: `pnpm vitest run src/features/connections/ConnectionForm.test.tsx`

Expected: failure because `onFocus` currently clears the mask.

- [ ] **Step 3: Select the untouched text mask and keep edits visible**

```tsx
<input
  aria-label="Password"
  type="text"
  value={values.password}
  onFocus={(event) => {
    if (connection && !passwordChanged) event.currentTarget.select();
  }}
  onChange={(event) => {
    setPasswordChanged(true);
    update("password", event.target.value);
  }}
/>
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run src/features/connections/ConnectionForm.test.tsx`

Commit: `git commit -m "feat: edit masked passwords directly"`

### Task 4: Complete verification

**Files:** none.

- [ ] **Step 1: Run required checks**

```powershell
cargo fmt --check
cargo test --features test-support
pnpm test
pnpm lint
pnpm tauri build
```

Expected: all tests pass, and Tauri creates MSI and NSIS bundles. Preserve unrelated user changes when committing.
