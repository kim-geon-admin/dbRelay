# Connection Lifecycle Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to enable disabled connections and delete unused connections from DB settings without exposing credentials or deleting flows.

**Architecture:** Add two narrowly typed IPC commands: one toggles only a connection's enabled state and one deletes a connection. `SettingsService` loads and updates the existing profile to preserve credential material, while the SQLite repository remains the transactional authority that rejects deletion of a flow-referenced connection. The React list renders the matching Enable/Disable control and a confirmation-gated Delete control, then refreshes its safe DTO list.

**Tech Stack:** Electron, context-isolated preload, React, TypeScript, Vitest, React Testing Library, better-sqlite3.

## Global Constraints

- The renderer may call only `window.dbRelay` through the named typed IPC allowlist.
- Connection DTOs expose only `passwordMask`; raw passwords, credential references, SQL, bind values, and source rows must not cross IPC or appear in messages.
- Deleting a connection referenced by a flow must fail without deleting or modifying the connection or any flow.
- Enable/Disable changes only the `enabled` flag and preserves the saved password.
- Run `pnpm vitest run electron/ipc/architecture.test.ts` after changing the renderer, preload, IPC, connector, or infrastructure boundary.

---

## File structure

- `electron/application/settingsService.ts`: exposes `setConnectionEnabled` while retaining credential-preserving profile updates and existing deletion delegation.
- `electron/application/settingsService.test.ts`: proves availability toggles preserve the existing plaintext password.
- `electron/ipc/commands.ts`: adds `set_connection_enabled` and `delete_connection` to the typed command, request, and response maps.
- `electron/ipc/handlers.ts`: validates and dispatches the new minimal requests, projecting safe connection/reference errors.
- `electron/ipc/handlers.test.ts`: exercises command dispatch, malformed-request rejection, and referenced-deletion projection.
- `electron/ipc/architecture.test.ts`: updates the exact allowlist expectation while retaining the generic-SQL prohibition.
- `src/lib/desktop.ts`: mirrors the two new typed commands across the renderer/preload boundary.
- `src/features/connections/connections.api.tsx`: provides renderer wrappers for enable/disable state changes and deletion.
- `src/features/connections/ConnectionList.tsx`: renders Enable for disabled profiles, confirmation-gated Delete, refreshes after mutation, and shows safe failure notices.
- `src/features/connections/ConnectionList.test.tsx`: verifies user-visible lifecycle controls and outcomes with the actual list component.

### Task 1: Add credential-preserving lifecycle operations at the typed IPC boundary

**Files:**
- Modify: `electron/application/settingsService.ts`, `electron/application/settingsService.test.ts`
- Modify: `electron/ipc/commands.ts`, `electron/ipc/handlers.ts`, `electron/ipc/handlers.test.ts`, `electron/ipc/architecture.test.ts`
- Modify: `src/lib/desktop.ts`

**Interfaces:**
- Produces `SettingsService.setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void>`.
- Produces `set_connection_enabled: { request: { connectionId: string; enabled: boolean } } -> ConnectionDto`.
- Produces `delete_connection: { request: { connectionId: string } } -> undefined`.

- [ ] **Step 1: Write the failing service behavior test**

Add this test to `electron/application/settingsService.test.ts`. It catches a regression where enabling overwrites an existing password or changes connection metadata.

```ts
it("enables an existing connection without replacing its password", async () => {
  const repository = new MemoryConnectionRepository();
  const service = new SettingsService(repository);
  await service.saveConnection({ ...profile(), enabled: false });

  await service.setConnectionEnabled("production", true);

  expect(repository.loadConnection("production")).toMatchObject({
    enabled: true,
    plaintextPassword: "secret123",
    host: "db.example.test",
  });
});
```

- [ ] **Step 2: Verify the service test is red**

Run: `pnpm vitest run electron/application/settingsService.test.ts`

Expected: FAIL because `setConnectionEnabled` does not exist.

- [ ] **Step 3: Implement the smallest lifecycle service method**

Add `setConnectionEnabled` to `SettingsService`. Validate `connectionId`, load it, throw `SettingsServiceError("CONNECTION_NOT_FOUND", "connection not found")` if absent, and call `repository.updateConnection({ ...existing, enabled })`. Do not call `saveConnection`, require a password, or accept renderer-supplied profile fields.

```ts
async setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void> {
  validateRequired(connectionId, "connection ID");
  const existing = this.repository.loadConnection(connectionId);
  if (existing === undefined) {
    throw new SettingsServiceError("CONNECTION_NOT_FOUND", "connection not found");
  }
  this.repository.updateConnection({ ...existing, enabled });
}
```

- [ ] **Step 4: Verify the service test is green**

Run: `pnpm vitest run electron/application/settingsService.test.ts`

Expected: PASS, including the existing disabled-state password preservation test.

- [ ] **Step 5: Write failing command-handler tests**

Add the following behavior tests to `electron/ipc/handlers.test.ts`. They catch accidental metadata updates, unknown-key acceptance, and loss of the repository's reference safeguard.

```ts
it("enables a disabled connection using only its ID and desired state", async () => {
  const { handler, repository } = fixture();
  repository.saveConnection({ ...connectionProfile(), enabled: false });

  await expect(handler("set_connection_enabled", {
    request: { connectionId: "production", enabled: true },
  })).resolves.toMatchObject({ id: "production", enabled: true, passwordMask: "******" });
  expect(repository.loadConnection("production")).toMatchObject({
    enabled: true,
    plaintextPassword: "s3cret",
  });
});

it("rejects deletion of a flow-referenced connection without changing either record", async () => {
  const { handler, repository } = fixtureWithReferencedConnection();

  await expect(handler("delete_connection", {
    request: { connectionId: "source" },
  })).rejects.toMatchObject({ code: "CONNECTION_REFERENCED" });
  expect(repository.loadConnection("source")).toBeDefined();
  expect(repository.loadFlow("daily")).toBeDefined();
});
```

Add reusable test fixtures that save the exact profiles and `Flow` they assert, rather than mocking `SettingsService`.

Use these helpers in the same test file so the example inputs are complete:

```ts
function connectionProfile(id = "production"): ConnectionProfile {
  return {
    id, displayName: id, kind: "oracle", host: "db.example.test", port: 1521,
    sid: "XE", username: "relay", credentialRef: id, credentialStorage: "plaintext",
    plaintextPassword: "s3cret", enabled: true, sourceReadOnly: false,
  };
}

function fixtureWithReferencedConnection() {
  const result = fixture();
  result.repository.saveConnection(connectionProfile("source"));
  result.repository.saveConnection(connectionProfile("target"));
  result.repository.saveFlow({
    id: "daily", name: "Daily", sourceConnectionId: "source", targetConnectionId: "target",
    querySteps: [{ id: "step-1", selectSql: "SELECT id FROM source_table", upsertSql: "MERGE INTO target_table USING dual ON (1 = 0) WHEN NOT MATCHED THEN INSERT (id) VALUES (:id)" }],
    transactionPolicy: "all_or_nothing", version: 0,
  });
  return result;
}
```

- [ ] **Step 6: Verify the handler tests are red**

Run: `pnpm vitest run electron/ipc/handlers.test.ts`

Expected: FAIL because the two commands are outside the allowlist.

- [ ] **Step 7: Implement command types, validation, dispatch, and safe errors**

In `electron/ipc/commands.ts` append `set_connection_enabled` and `delete_connection` to `DB_RELAY_COMMANDS`; add their request and response-map members exactly as declared above. Mirror those type-map members in `src/lib/desktop.ts`.

Extend `SettingsBoundary` in `electron/ipc/handlers.ts` with `setConnectionEnabled` and `deleteConnection`. Dispatch availability changes by calling the service and then `findConnection(await services.settings.listConnectionDtos(), connectionId)`. Dispatch deletion by awaiting `deleteConnection` and returning `undefined`. In `isValidRequestBody`, accept only `connectionId` and boolean `enabled` for `set_connection_enabled`, and only `connectionId` for `delete_connection`.

Add safe presentation strings for `CONNECTION_REFERENCED`:

```ts
case "CONNECTION_REFERENCED":
  return "The connection is used by a flow and cannot be deleted.";
```

and title `"Connection is in use"`. Keep unknown errors generic. Update `electron/ipc/architecture.test.ts` to expect the complete new allowlist and retain its assertion that no command permits generic SQL execution.

- [ ] **Step 8: Verify the IPC boundary is green**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts`

Expected: PASS; the handler returns only safe DTO fields and rejects a referenced deletion.

- [ ] **Step 9: Commit the boundary implementation**

```bash
git add electron/application/settingsService.ts electron/application/settingsService.test.ts electron/ipc/commands.ts electron/ipc/handlers.ts electron/ipc/handlers.test.ts electron/ipc/architecture.test.ts src/lib/desktop.ts
git commit -m "feat: add connection lifecycle IPC controls"
```

### Task 2: Render and exercise DB-settings lifecycle controls

**Files:**
- Modify: `src/features/connections/connections.api.tsx`, `src/features/connections/ConnectionList.tsx`
- Create: `src/features/connections/ConnectionList.test.tsx`

**Interfaces:**
- Produces `setConnectionEnabled(id: string, enabled: boolean): Promise<Connection>` and `deleteConnection(id: string): Promise<void>` renderer API wrappers.
- Produces an accessible `ConnectionList` card with Edit, Test, Enable/Disable, and Delete actions.

- [ ] **Step 1: Write the failing disabled-to-enabled UI test**

Create `src/features/connections/ConnectionList.test.tsx`, mock only `connections.api` at its external desktop-command boundary, and render the real `ConnectionList`. The test catches the current bug where disabled cards render no recovery action.

Define the mocked module and fixtures before the tests:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionList } from "./ConnectionList";
import * as api from "./connections.api";

vi.mock("./connections.api", () => ({
  listConnections: vi.fn(), saveConnection: vi.fn(), testConnection: vi.fn(),
  setConnectionEnabled: vi.fn(), deleteConnection: vi.fn(),
}));

const { listConnections, setConnectionEnabled, deleteConnection } = vi.mocked(api);
const disabledConnection = { id: "production", displayName: "Production", kind: "oracle" as const, host: "db.example.test", port: 1521, sid: "XE", username: "relay", passwordMask: "******", enabled: false };
const enabledConnection = { ...disabledConnection, enabled: true };

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
```

```tsx
it("enables a disabled connection and refreshes the card", async () => {
  listConnections.mockResolvedValueOnce([disabledConnection]).mockResolvedValueOnce([
    { ...disabledConnection, enabled: true },
  ]);
  setConnectionEnabled.mockResolvedValue({ ...disabledConnection, enabled: true });

  render(<ConnectionList />);
  expect(await screen.findByRole("button", { name: "Enable" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Enable" }));

  expect(setConnectionEnabled).toHaveBeenCalledWith("production", true);
  expect(await screen.findByText("Production enabled.")).toBeVisible();
  expect(screen.getByText("Enabled")).toBeVisible();
});
```

- [ ] **Step 2: Verify the enable UI test is red**

Run: `pnpm vitest run src/features/connections/ConnectionList.test.tsx`

Expected: FAIL because disabled cards have no Enable button or renderer API wrapper.

- [ ] **Step 3: Implement the minimal enable/disable UI path**

Add the two wrappers in `connections.api.tsx`:

```ts
export function setConnectionEnabled(id: string, enabled: boolean): Promise<Connection> {
  return invokeCommand("set_connection_enabled", { request: { connectionId: id, enabled } });
}

export function deleteConnection(id: string): Promise<void> {
  return invokeCommand("delete_connection", { request: { connectionId: id } });
}
```

In `ConnectionList`, replace the `disable` handler with `setEnabled(connection, enabled)`, then show `Enable` when `connection.enabled` is false and `Disable` when true. Await the API call, refresh, and use notices `"{name} enabled."` and `"{name} disabled."`. On failure, set only a fixed, safe availability failure notice.

- [ ] **Step 4: Verify the enable UI test is green**

Run: `pnpm vitest run src/features/connections/ConnectionList.test.tsx`

Expected: PASS; the card reloads as enabled after the explicit Enable action.

- [ ] **Step 5: Write the failing delete UI tests**

Add these tests using `vi.spyOn(window, "confirm")`; restore the spy after each test. They catch deletion without confirmation and incorrect removal after a rejection.

```tsx
it("deletes an unreferenced connection after confirmation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValueOnce([enabledConnection]).mockResolvedValueOnce([]);
  deleteConnection.mockResolvedValue(undefined);

  render(<ConnectionList />);
  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(deleteConnection).toHaveBeenCalledWith("production");
  expect(await screen.findByText("Production deleted.")).toBeVisible();
  expect(screen.queryByText("Production")).not.toBeInTheDocument();
});

it("keeps a connection when deletion is rejected because a flow references it", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValue([enabledConnection]);
  deleteConnection.mockRejectedValue({ code: "CONNECTION_REFERENCED" });

  render(<ConnectionList />);
  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(await screen.findByText("This connection is used by a flow and cannot be deleted.")).toBeVisible();
  expect(screen.getByText("Production")).toBeVisible();
});
```

- [ ] **Step 6: Verify the delete UI tests are red**

Run: `pnpm vitest run src/features/connections/ConnectionList.test.tsx`

Expected: FAIL because no Delete button, confirmation, or rejection notice exists.

- [ ] **Step 7: Implement confirmation-gated deletion and safe rejection feedback**

Add a Delete action to every card. It must return without calling the API when `window.confirm('Delete {displayName}? This cannot be undone.')` is false. On confirmed deletion, await the wrapper, refresh the list, and show `"{name} deleted."`. If the caught safe error has code `CONNECTION_REFERENCED`, show exactly `"This connection is used by a flow and cannot be deleted."`; for all other errors show `"{name} could not be deleted."`. Do not include caught error text in a notice.

- [ ] **Step 8: Verify the complete renderer lifecycle suite is green**

Run: `pnpm vitest run src/features/connections/ConnectionList.test.tsx src/features/connections/ConnectionForm.test.tsx`

Expected: PASS, including confirmation cancel behavior if added during implementation.

- [ ] **Step 9: Commit the renderer implementation**

```bash
git add src/features/connections/connections.api.tsx src/features/connections/ConnectionList.tsx src/features/connections/ConnectionList.test.tsx
git commit -m "feat: manage connection availability and deletion"
```

### Task 3: Run required verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the targeted structural regression check**

Run: `pnpm vitest run electron/ipc/architecture.test.ts`

Expected: PASS; named allowlist is current and no generic SQL command is exposed.

- [ ] **Step 2: Run the required project checks**

Run these commands in order:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

Expected: every command exits with code 0. Do not run the opt-in Oracle integration test unless `DB_RELAY_ORACLE_TEST_URL` is intentionally supplied.

- [ ] **Step 3: Inspect the final scope**

Run: `git status --short; git diff --check HEAD~2..HEAD`

Expected: only the lifecycle feature commits are included; unrelated pre-existing untracked artifacts remain untouched and there is no whitespace error.
