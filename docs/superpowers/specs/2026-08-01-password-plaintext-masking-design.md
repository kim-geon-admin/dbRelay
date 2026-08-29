# Plaintext password storage with masked display

## Goal

Store connection passwords in the local SQLite database as plaintext while
showing only a same-length asterisk mask after a connection is saved or
loaded. Keep the existing Windows Keyring implementation and existing Keyring
profiles intact for future use.

## Data model and migration

- New connections save their password in `plaintext_password` and set
  `credential_storage` to `plaintext`.
- Updating a connection with a replacement password also saves that value as
  plaintext.
- Existing Keyring profiles are not deleted or rewritten automatically.
- A Keyring profile can be converted to plaintext only when its password is
  supplied through the edit form. Profiles whose Keyring entry is unavailable
  therefore remain unchanged until a user supplies a replacement password.

## UI behavior

- On loading a saved connection, Password displays literal `*` characters
  matching the stored password length.
- Clicking the Password field keeps the mask in place and gives the field
  focus.
- The first direct edit or paste replaces the selected mask. While a user is
  editing, the newly entered password is visible as plaintext.
- After a successful save and subsequent refresh, the Password field shows the
  same-length asterisk mask again.
- No checkbox or separate password-change button is added.

## API and security boundary

- The command response continues to return `passwordMask`, never the plaintext
  password.
- Password length is computed in the backend from the plaintext field for
  plaintext profiles, and from the resolved secret for existing Keyring
  profiles.
- For a Keyring profile whose credential is unavailable, the UI retains the
  safe fallback mask until the user supplies a replacement password.

## Verification

- Backend tests cover plaintext persistence, mask length, and existing
  Keyring-profile compatibility.
- Form tests cover literal mask rendering, preserving it on focus, and
  plaintext editing before save.
- Run frontend tests, Rust tests, lint, and a Tauri package build.
