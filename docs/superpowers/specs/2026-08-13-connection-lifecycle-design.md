# Connection lifecycle controls

## Goal

Let a user delete an unused database connection from DB settings and restore a disabled connection to the enabled state.

## Scope and behavior

- Each connection card exposes a Delete action.
- Delete asks for confirmation before requesting deletion.
- Deletion removes only the selected connection. If a flow references it as a source or target, deletion is rejected; neither the connection nor any flow is changed.
- Enabled cards show Disable. Disabled cards show Enable in the same action location.
- Enabling and disabling change only the `enabled` state. They do not alter endpoint metadata or replace the saved credential.
- Successful mutations refresh the connection list and show a concise status message. Failed mutations show a safe status message without credentials, SQL, bind values, or source rows.

## Architecture and data flow

The renderer continues to call the context-isolated preload through named typed IPC commands only. A dedicated command accepts a connection ID and the requested enabled state, which prevents the renderer from resubmitting connection metadata merely to toggle availability. The main-process handler validates the minimal request, delegates to `SettingsService`, and returns the existing safe connection DTO. The service loads the existing profile, changes `enabled`, and delegates persistence to the repository.

Deletion is exposed through a separate typed IPC command accepting only the connection ID. The existing repository transaction remains the authority for the referential check: it rejects deletion when any flow references the profile. The command boundary projects that error to the renderer without leaking sensitive data.

## Error handling

- A missing connection returns the existing safe not-found error.
- A referenced connection returns a dedicated safe error that the renderer presents as an explanatory notice.
- A failed enable, disable, or delete leaves the displayed data unchanged until a later successful refresh.

## Tests

- A renderer test verifies a disabled connection renders Enable, invokes the availability action, and refreshes to the enabled state.
- A renderer test verifies Delete asks for confirmation, calls deletion after confirmation, and removes the card after refresh.
- Main-process tests verify minimal request validation and command dispatch for availability changes and deletion.
- Settings-service and repository tests verify enabling preserves the existing password and referenced connections cannot be deleted.
- The IPC architecture test remains green, proving the renderer uses only the named allowlist and DTOs remain secret-free.
