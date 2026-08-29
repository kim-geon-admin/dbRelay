import { fireEvent, render, screen, within } from "@testing-library/react";
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

const { listConnections, testConnection, setConnectionEnabled, deleteConnection } = vi.mocked(api);

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
  listConnections.mockResolvedValueOnce([enabledConnection]).mockResolvedValueOnce([]);
  deleteConnection.mockResolvedValue(undefined);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(screen.getByRole("alertdialog", { name: "DB 설정 삭제" })).toBeVisible();
  expect(deleteConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));

  expect(deleteConnection).toHaveBeenCalledWith("production");
  expect(await screen.findByText("Production deleted.")).toBeVisible();
  expect(screen.queryByText("Production")).not.toBeInTheDocument();
});

it("removes the card when deletion succeeds but refresh fails", async () => {
  listConnections.mockResolvedValueOnce([enabledConnection]).mockRejectedValueOnce(new Error("refresh failed"));
  deleteConnection.mockResolvedValue(undefined);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));

  expect(deleteConnection).toHaveBeenCalledWith("production");
  expect(await screen.findByText("Production deleted, but the list could not be refreshed.")).toBeVisible();
  expect(screen.queryByText("Production")).not.toBeInTheDocument();
});

it("keeps a connection when deletion is rejected because a flow references it", async () => {
  listConnections.mockResolvedValue([enabledConnection]);
  deleteConnection.mockRejectedValue({ code: "CONNECTION_REFERENCED" });

  render(<ConnectionList />);

  const card = (await screen.findByText("Production")).closest(".connection-card");
  expect(card).not.toBeNull();
  const initialCardText = card?.textContent;

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));

  expect(await screen.findByText("flow에서 사용중이라 삭제할 수 없습니다.")).toBeVisible();
  expect(screen.getByText("Production")).toBeVisible();
  expect(card?.textContent).toBe(initialCardText);
  expect(screen.getByText("Enabled")).toBeVisible();
  expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Test" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Disable" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  expect(listConnections).toHaveBeenCalledTimes(1);
});

it("does not delete when the confirmation dialog is cancelled", async () => {
  listConnections.mockResolvedValue([enabledConnection]);

  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));

  expect(deleteConnection).not.toHaveBeenCalled();
  expect(listConnections).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Production")).toBeVisible();
});

it("keeps the enabled state and actions in dedicated card columns", async () => {
  const longNameConnection = { ...enabledConnection, displayName: "A database connection name that needs flexible space" };
  listConnections.mockResolvedValue([longNameConnection]);

  render(<ConnectionList />);

  const card = await screen.findByText(longNameConnection.displayName);
  expect(card.closest(".connection-card__details")).toBeInTheDocument();
  expect(screen.getByText("Enabled").closest(".connection-card__status")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Disable" }).closest(".connection-card__actions")).toBeInTheDocument();
});

it("keeps the connection failure notice and shows a safe error code and detail below it", async () => {
  listConnections.mockResolvedValue([enabledConnection]);
  testConnection.mockRejectedValue({
    code: "ORA-12505",
    detail: "password=not-for-ui; connectString=(DESCRIPTION=private)",
  });
  render(<ConnectionList />);

  fireEvent.click(await screen.findByRole("button", { name: "Test" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Production could not be connected.");
  const detail = screen.getByRole("alert");
  expect(detail).toHaveTextContent("ORA-12505");
  expect(detail).not.toHaveTextContent("password=not-for-ui");
  expect(detail).not.toHaveTextContent("connectString");
});

it("renders the connection editor directly below the edited card", async () => {
  const reportingConnection = { ...enabledConnection, id: "reporting", displayName: "Reporting" };
  listConnections.mockResolvedValue([enabledConnection, reportingConnection]);
  render(<ConnectionList />);

  const productionCard = (await screen.findByText("Production")).closest(".connection-card") as HTMLElement;
  const reportingCard = screen.getByText("Reporting").closest(".connection-card") as HTMLElement;
  fireEvent.click(within(productionCard).getByRole("button", { name: "Edit" }));

  expect(within(productionCard).getByRole("heading", { name: "Edit connection" })).toBeVisible();

  fireEvent.click(within(reportingCard).getByRole("button", { name: "Edit" }));

  expect(within(productionCard).queryByRole("heading", { name: "Edit connection" })).not.toBeInTheDocument();
  expect(within(reportingCard).getByRole("heading", { name: "Edit connection" })).toBeVisible();

  fireEvent.click(within(reportingCard).getByRole("button", { name: "Edit" }));

  expect(screen.queryByRole("heading", { name: "Edit connection" })).not.toBeInTheDocument();
});
