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

it("keeps a connection when deletion is rejected because a flow references it", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  listConnections.mockResolvedValue([enabledConnection]);
  deleteConnection.mockRejectedValue({ code: "CONNECTION_REFERENCED" });

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

  expect(await screen.findByText("This connection is used by a flow and cannot be deleted.")).toBeVisible();
  expect(screen.getByText("Production")).toBeVisible();
});
