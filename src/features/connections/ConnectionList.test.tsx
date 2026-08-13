import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionList } from "./ConnectionList";
import * as api from "./connections.api";

vi.mock("./connections.api", () => ({
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
  testConnection: vi.fn(),
  setConnectionEnabled: vi.fn(),
  deleteConnection: vi.fn(),
}));

const { listConnections, setConnectionEnabled, deleteConnection } = vi.mocked(api);

const disabledConnection = {
  id: "production",
  displayName: "Production",
  kind: "oracle" as const,
  host: "db.example.test",
  port: 1521,
  sid: "XE",
  username: "relay",
  passwordMask: "******",
  enabled: false,
};

const enabledConnection = { ...disabledConnection, enabled: true };

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("enables a disabled connection and refreshes the card", async () => {
  listConnections
    .mockResolvedValueOnce([disabledConnection])
    .mockResolvedValueOnce([{ ...disabledConnection, enabled: true }]);
  setConnectionEnabled.mockResolvedValue({ ...disabledConnection, enabled: true });

  render(<ConnectionList />);

  expect(await screen.findByRole("button", { name: "Enable" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Enable" }));

  expect(setConnectionEnabled).toHaveBeenCalledWith("production", true);
  expect(await screen.findByText("Production enabled.")).toBeVisible();
  expect(screen.getByText("Enabled")).toBeVisible();
});

it("keeps the enabled card updated when enabling succeeds but refresh fails", async () => {
  listConnections.mockResolvedValueOnce([disabledConnection]).mockRejectedValueOnce(new Error("refresh failed"));
  setConnectionEnabled.mockResolvedValue(enabledConnection);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

  expect(setConnectionEnabled).toHaveBeenCalledWith("production", true);
  expect(await screen.findByText("Production enabled, but the list could not be refreshed.")).toBeVisible();
  expect(screen.getByText("Enabled")).toBeVisible();
  expect(screen.getByRole("button", { name: "Disable" })).toBeVisible();
});

it("deletes an unreferenced connection after confirmation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValueOnce([enabledConnection]).mockResolvedValueOnce([]);
  deleteConnection.mockResolvedValue(undefined);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(deleteConnection).toHaveBeenCalledWith("production");
  expect(await screen.findByText("Production deleted.")).toBeVisible();
  expect(screen.queryByText("Production")).not.toBeInTheDocument();
});

it("removes the card when deletion succeeds but refresh fails", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValueOnce([enabledConnection]).mockRejectedValueOnce(new Error("refresh failed"));
  deleteConnection.mockResolvedValue(undefined);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(deleteConnection).toHaveBeenCalledWith("production");
  expect(await screen.findByText("Production deleted, but the list could not be refreshed.")).toBeVisible();
  expect(screen.queryByText("Production")).not.toBeInTheDocument();
});

it("keeps a connection when deletion is rejected because a flow references it", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValue([enabledConnection]);
  deleteConnection.mockRejectedValue({ code: "CONNECTION_REFERENCED" });

  render(<ConnectionList />);

  const card = (await screen.findByText("Production")).closest(".connection-card");
  expect(card).not.toBeNull();
  const initialCardText = card?.textContent;

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  expect(await screen.findByText("This connection is used by a flow and cannot be deleted.")).toBeVisible();
  expect(screen.getByText("Production")).toBeVisible();
  expect(card?.textContent).toBe(initialCardText);
  expect(screen.getByText("Enabled")).toBeVisible();
  expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Test" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Disable" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  expect(listConnections).toHaveBeenCalledTimes(1);
});

it("does not delete when confirmation is cancelled", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  listConnections.mockResolvedValue([enabledConnection]);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(confirm).toHaveBeenCalledWith("Delete Production? This cannot be undone.");
  expect(deleteConnection).not.toHaveBeenCalled();
  expect(listConnections).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Production")).toBeVisible();
});
