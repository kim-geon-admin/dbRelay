# Optional Credential Encryption Design

## Goal

Let an operator choose how each database connection password is persisted. The
existing encrypted OS-keyring behavior remains the default. An operator may
explicitly opt out and persist a password in the local SQLite database so that
the connection editor can show it again.

## User experience

- The connection form shows one clearly labelled `Encrypt password storage`
  checkbox immediately above the password field. It is checked by default for
  new connections.
- With the checkbox checked, saving and editing use the existing Windows
  Credential Manager flow. The editor never receives the password and starts
  with an empty password field.
- With the checkbox unchecked, saving writes the password to SQLite and an
  edited connection returns and displays that password in a text input.
- Saving an edited encrypted connection with an empty password keeps its
  existing credential. Saving an edited plaintext connection with an empty
  password keeps its existing plaintext password.
- Changing modes requires a non-empty password, so the destination store
  always has a usable credential before the old one is removed.
- Remove the `Source account is read-only` control and the `leave blank to
  keep existing` hint. The source-read-only attestation is no longer enforced
  when saving flows or starting runs; existing stored values may remain as
  legacy data but are ignored.

## Persistence and command boundary

- Add a `credential_storage` mode to `connection_profiles`, with `keyring` as
  the default for existing rows, plus a nullable `plaintext_password` column.
- A `keyring` row stores only the credential reference in SQLite and keeps its
  password in Windows Credential Manager. A `plaintext` row stores its actual
  password in SQLite and has no active keyring credential.
- Connection command responses include the storage mode. They include a
  password only for the explicitly selected plaintext mode; encrypted
  connection responses never contain one.
- When a connection changes from keyring to plaintext, persist the plaintext
  row first and then delete its keyring credential. When changing from
  plaintext to keyring, write the keyring credential first and then clear the
  plaintext column. Failed transitions leave the previously working mode
  intact.
- Both modes resolve through the same application credential port at test and
  run time. SQL, bind values, source rows, and execution-history sanitisation
  remain unchanged.

## Validation and tests

- Frontend tests cover the default encrypted checkbox, the removal of the
  source-read-only and legacy hint text, and display of a returned plaintext
  password.
- Rust command and persistence tests cover round-tripping both modes, response
  serialization that omits encrypted secrets, response serialization that
  includes explicitly plaintext secrets, and both mode transitions.
- Flow/run tests cover that an unchecked legacy source-read-only value no
  longer blocks flow save or execution.

## Security consequence

Choosing plaintext storage intentionally exposes the password through the
application UI and stores it unencrypted in the local SQLite application data
file. Operators must protect the Windows account and app-data directory
accordingly. Encryption remains the default.
