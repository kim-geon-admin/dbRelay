import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { FlowLibrary } from "./FlowLibrary";

const { deleteFlow, exportFlow, importFlow, listFlows, listConnections, saveFlow } = vi.hoisted(() => ({
  deleteFlow: vi.fn(),
  exportFlow: vi.fn(),
  importFlow: vi.fn(),
  listFlows: vi.fn(),
  listConnections: vi.fn(),
  saveFlow: vi.fn(),
}));

vi.mock("./flows.api", () => ({
  deleteFlow,
  duplicateFlow: vi.fn(),
  exportFlow,
  importFlow,
  listFlows,
  saveFlow,
}));

vi.mock("../connections/connections.api", () => ({
  listConnections,
}));

const savedFlow = {
  id: "daily-sync",
  name: "Daily sync",
  sourceConnectionId: "source",
  targetConnectionId: "target",
  querySteps: [{ id: "step-1", selectSql: "select 1", upsertSql: "merge 1" }],
  transactionPolicy: "all_or_nothing" as const,
  version: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  listFlows.mockResolvedValue([savedFlow]);
  listConnections.mockResolvedValue([
    { id: "source", displayName: "Source DB", kind: "oracle", host: "source", port: 1521, sid: "source", username: "reader", sourceReadOnly: true, enabled: true },
    { id: "target", displayName: "Target DB", kind: "oracle", host: "target", port: 1521, sid: "target", username: "writer", sourceReadOnly: false, enabled: true },
  ]);
  saveFlow.mockResolvedValue(savedFlow);
  deleteFlow.mockResolvedValue(undefined);
  exportFlow.mockResolvedValue({ exported: true });
  importFlow.mockResolvedValue({ status: "cancelled" });
});

it("shows the new-flow form above the saved-flow cards", async () => {
  render(<FlowLibrary />);

  expect(await screen.findByText("Daily sync")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "New flow" }));

  await waitFor(() => expect(screen.getByRole("heading", { name: "New flow" })).toBeVisible());
  const editor = document.querySelector("form.flow-editor");
  const savedFlows = document.querySelector("ul.flow-list");

  expect(editor).toBeInTheDocument();
  expect(savedFlows).toBeInTheDocument();
  expect(editor!.compareDocumentPosition(savedFlows!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("Daily sync")).toBeVisible();
});

it("filters saved flows by name as the user types and restores all flows when cleared", async () => {
  listFlows.mockResolvedValueOnce([
    savedFlow,
    { ...savedFlow, id: "customer-sync", name: "Customer sync" },
  ]);
  render(<FlowLibrary />);

  await screen.findByText("Customer sync");
  const filter = screen.getByRole("textbox", { name: "Filter flows by name" });
  fireEvent.change(filter, { target: { value: "customer" } });

  expect(screen.getByText("Customer sync")).toBeVisible();
  expect(screen.queryByText("Daily sync")).not.toBeInTheDocument();

  fireEvent.change(filter, { target: { value: "" } });
  expect(screen.getByText("Daily sync")).toBeVisible();
  expect(screen.getByText("Customer sync")).toBeVisible();
});

it("opens the imported flow editor when a referenced connection is unavailable", async () => {
  importFlow.mockResolvedValue({
    status: "needs_connection_selection",
    flow: {
      ...savedFlow,
      id: "imported-flow",
      name: "Imported daily",
      sourceConnectionId: "",
      version: 0,
    },
  });
  render(<FlowLibrary />);

  await screen.findByText("Daily sync");
  fireEvent.click(screen.getByRole("button", { name: "Import flow" }));

  expect(await screen.findByRole("heading", { name: "Edit flow" })).toBeVisible();
  expect(screen.getByLabelText("Flow name")).toHaveValue("Imported daily");
  expect(screen.getByLabelText("Source connection")).toHaveValue("");
  expect(screen.getByLabelText("Target connection")).toHaveValue("target");
});

it("shows an all-or-nothing policy in Korean", async () => {
  render(<FlowLibrary />);

  expect(await screen.findByText("전체 롤백")).toBeVisible();
  expect(screen.queryByText("All or nothing")).not.toBeInTheDocument();
});

it("shows a commit-successes policy in Korean", async () => {
  listFlows.mockResolvedValueOnce([{ ...savedFlow, transactionPolicy: "commit_successes" as const }]);
  render(<FlowLibrary />);

  expect(await screen.findByText("성공한 부분까지 커밋")).toBeVisible();
  expect(screen.queryByText("Commit successes")).not.toBeInTheDocument();
});

it("marks the flow editor so its query area can use the larger layout", async () => {
  render(<FlowLibrary />);

  fireEvent.click(screen.getByRole("button", { name: "New flow" }));

  await screen.findByRole("heading", { name: "New flow" });
  expect(document.querySelector("form.flow-editor")).toBeInTheDocument();
});

it("closes the new-flow form without hiding saved flows", async () => {
  render(<FlowLibrary />);

  fireEvent.click(screen.getByRole("button", { name: "New flow" }));
  await screen.findByRole("heading", { name: "New flow" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("heading", { name: "New flow" })).not.toBeInTheDocument();
  expect(screen.getByText("Daily sync")).toBeVisible();
});

it("saves the new flow through the save API and refreshes the editor", async () => {
  render(<FlowLibrary />);

  fireEvent.click(screen.getByRole("button", { name: "New flow" }));
  await screen.findByRole("heading", { name: "New flow" });
  fireEvent.change(screen.getByLabelText("Flow name"), { target: { value: "Customer sync" } });
  fireEvent.change(screen.getByLabelText("Source connection"), { target: { value: "source" } });
  fireEvent.change(screen.getByLabelText("Target connection"), { target: { value: "target" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Source SQL for step 1" }), { target: { value: "select id from customers" } });
  fireEvent.click(screen.getByRole("button", { name: "Save flow" }));

  await waitFor(() => expect(saveFlow).toHaveBeenCalledWith(expect.objectContaining({
    name: "Customer sync",
    sourceConnectionId: "source",
    targetConnectionId: "target",
    querySteps: [{ id: expect.any(String), title: "Step 1", operation: "insert", selectSql: "select id from customers", upsertSql: "INSERT INTO customers (id)\nVALUES (:id)" }],
  })));
  expect(await screen.findByRole("status")).toHaveTextContent("Flow saved.");
  expect(screen.queryByRole("heading", { name: "New flow" })).not.toBeInTheDocument();
  expect(screen.getByText("Daily sync")).toBeVisible();
});

it("keeps an edited flow open after saving and shows a Korean success message", async () => {
  render(<FlowLibrary />);

  const card = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(card).getByRole("textbox", { name: "Source SQL for step 1" }), { target: { value: "SELECT id FROM customers" } });
  fireEvent.click(within(card).getByRole("button", { name: "Save flow" }));

  await waitFor(() => expect(saveFlow).toHaveBeenCalled());
  expect(within(card).getByRole("heading", { name: "Edit flow" })).toBeVisible();
  const saved = await screen.findByRole("status");
  expect(saved).toHaveTextContent("저장되었습니다");
  expect(saved.closest("form.flow-editor")).toBeTruthy();
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

it("keeps an edited flow saved when the subsequent list refresh fails", async () => {
  listFlows.mockResolvedValueOnce([savedFlow]).mockRejectedValueOnce(new Error("refresh failed"));
  saveFlow.mockResolvedValue({ ...savedFlow, version: 2 });
  render(<FlowLibrary />);

  const card = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
  fireEvent.click(within(card).getByRole("button", { name: "Save flow" }));

  expect(await screen.findByRole("status")).toHaveTextContent("저장되었습니다");
  expect(within(card).getByRole("heading", { name: "Edit flow" })).toBeVisible();
});

it("deletes the selected flow from the card action area", async () => {
  listFlows.mockResolvedValueOnce([savedFlow]).mockResolvedValueOnce([]);
  render(<FlowLibrary />);

  const card = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));

  const dialog = screen.getByRole("alertdialog", { name: "쿼리 시퀀스 삭제" });
  expect(deleteFlow).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

  await waitFor(() => expect(deleteFlow).toHaveBeenCalledWith("daily-sync"));
  expect(screen.queryByText("Daily sync")).not.toBeInTheDocument();
});

it("keeps a flow when flow deletion is cancelled", async () => {
  render(<FlowLibrary />);

  const card = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "쿼리 시퀀스 삭제" })).getByRole("button", { name: "취소" }));

  expect(deleteFlow).not.toHaveBeenCalled();
  expect(screen.getByText("Daily sync")).toBeVisible();
});

it("removes a deleted flow even when the subsequent list refresh fails", async () => {
  listFlows.mockResolvedValueOnce([savedFlow]).mockRejectedValueOnce(new Error("refresh failed"));
  render(<FlowLibrary />);

  const card = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "쿼리 시퀀스 삭제" })).getByRole("button", { name: "삭제" }));

  await waitFor(() => expect(deleteFlow).toHaveBeenCalledWith("daily-sync"));
  expect(screen.queryByText("Daily sync")).not.toBeInTheDocument();
});

it("keeps the policy and actions in dedicated card columns", async () => {
  listFlows.mockResolvedValueOnce([{
    ...savedFlow,
    name: "A flow name that is long enough to need flexible space",
  }]);
  render(<FlowLibrary />);

  const card = await screen.findByText("A flow name that is long enough to need flexible space");
  expect(card.closest(".flow-card__details")).toBeInTheDocument();
  expect(card.closest(".flow-card__details")?.querySelector(".flow-card__policy")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit" }).closest(".flow-card__actions")).toBeInTheDocument();
});

it("renders the flow editor directly below the edited card", async () => {
  const weeklyFlow = { ...savedFlow, id: "weekly-sync", name: "Weekly sync" };
  listFlows.mockResolvedValue([savedFlow, weeklyFlow]);
  render(<FlowLibrary />);

  const dailyCard = (await screen.findByText("Daily sync")).closest(".flow-card") as HTMLElement;
  const weeklyCard = screen.getByText("Weekly sync").closest(".flow-card") as HTMLElement;
  fireEvent.click(within(dailyCard).getByRole("button", { name: "Edit" }));

  expect(within(dailyCard).getByRole("heading", { name: "Edit flow" })).toBeVisible();

  fireEvent.click(within(weeklyCard).getByRole("button", { name: "Edit" }));

  expect(within(dailyCard).queryByRole("heading", { name: "Edit flow" })).not.toBeInTheDocument();
  expect(within(weeklyCard).getByRole("heading", { name: "Edit flow" })).toBeVisible();

  fireEvent.click(within(weeklyCard).getByRole("button", { name: "Edit" }));

  expect(screen.queryByRole("heading", { name: "Edit flow" })).not.toBeInTheDocument();
});
