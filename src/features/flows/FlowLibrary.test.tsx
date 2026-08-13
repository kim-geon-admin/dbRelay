import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { FlowLibrary } from "./FlowLibrary";

const { listFlows, listConnections, saveFlow } = vi.hoisted(() => ({
  listFlows: vi.fn(),
  listConnections: vi.fn(),
  saveFlow: vi.fn(),
}));

vi.mock("./flows.api", () => ({
  duplicateFlow: vi.fn(),
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
  vi.clearAllMocks();
  listFlows.mockResolvedValue([savedFlow]);
  listConnections.mockResolvedValue([
    { id: "source", displayName: "Source DB", kind: "oracle", host: "source", port: 1521, sid: "source", username: "reader", sourceReadOnly: true, enabled: true },
    { id: "target", displayName: "Target DB", kind: "oracle", host: "target", port: 1521, sid: "target", username: "writer", sourceReadOnly: false, enabled: true },
  ]);
  saveFlow.mockResolvedValue(savedFlow);
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
    querySteps: [{ id: expect.any(String), operation: "insert", selectSql: "select id from customers", upsertSql: "INSERT INTO customers (id)\nVALUES (:id)" }],
  })));
  expect(await screen.findByRole("status")).toHaveTextContent("Flow saved.");
  expect(screen.queryByRole("heading", { name: "New flow" })).not.toBeInTheDocument();
  expect(screen.getByText("Daily sync")).toBeVisible();
});
