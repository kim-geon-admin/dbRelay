import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { FlowEditor } from "./FlowEditor";

it("keeps query steps in the order selected by the user", () => {
  render(
    <FlowEditor
      connections={[]}
      initialFlow={{
        id: "daily-sync",
        name: "Daily sync",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [
          { id: "one", selectSql: "select 1", upsertSql: "merge 1" },
          { id: "two", selectSql: "select 2", upsertSql: "merge 2" },
          { id: "three", selectSql: "select 3", upsertSql: "merge 3" },
        ],
      }}
      onSave={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Move step 2 down" }));

  expect(screen.getAllByTestId("query-step").map((step) => step.dataset.stepId)).toEqual([
    "one",
    "three",
    "two",
  ]);
});

it("shows only executable target bind names", () => {
  render(
    <FlowEditor
      connections={[]}
      initialFlow={{
        id: "daily-sync",
        name: "Daily sync",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [{
          id: "one",
          selectSql: "select 1",
          upsertSql: "merge into x using ':literal' -- :line-comment\n/* :block-comment */ on (id = :ID) when matched then update set email = :email",
        }],
      }}
      onSave={vi.fn()}
    />,
  );

  expect(screen.getByText("Target binds: ID, email")).toBeVisible();
});

it("fills legacy and newly added steps with ordinal titles", () => {
  render(<FlowEditor connections={[]} onSave={vi.fn()} />);

  expect(screen.getByRole("textbox", { name: "Step title for step 1" })).toHaveValue("Step 1");
  fireEvent.click(screen.getByRole("button", { name: "Add step" }));
  expect(screen.getByRole("textbox", { name: "Step title for step 2" })).toHaveValue("Step 2");
});

it("allows saving a flow with the same source and target connection", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <FlowEditor
      connections={[{ id: "local", displayName: "Local DB", kind: "oracle", host: "localhost", port: 1521, sid: "XE", username: "test", passwordMask: "*****", enabled: true }]}
      initialFlow={{
        id: "same-db-flow",
        name: "Same DB flow",
        sourceConnectionId: "local",
        targetConnectionId: "local",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [{ id: "step", selectSql: "SELECT 1", upsertSql: "INSERT INTO target_table (id) VALUES (:ID)" }],
      }}
      onSave={onSave}
    />,
  );

  fireEvent.submit(screen.getByRole("button", { name: "Save flow" }).closest("form")!);

  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    sourceConnectionId: "local",
    targetConnectionId: "local",
  }));
});

it("uses Korean labels for transaction policies", () => {
  render(<FlowEditor connections={[]} onSave={vi.fn()} />);

  expect(screen.getByRole("option", { name: "전체 롤백" })).toHaveValue("all_or_nothing");
  expect(screen.getByRole("option", { name: "성공한 부분까지 커밋" })).toHaveValue("commit_successes");
});

it("shows the saved message in the same feedback area as validation errors", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <FlowEditor
      connections={[]}
      initialFlow={{
        id: "daily-sync",
        name: "",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [{ id: "step", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customer (id) VALUES (:id)" }],
      }}
      onSave={onSave}
    />,
  );

  fireEvent.submit(screen.getByRole("button", { name: "Save flow" }).closest("form")!);
  expect(screen.getByRole("alert")).toHaveClass("flow-editor__feedback");

  fireEvent.change(screen.getByLabelText("Flow name"), { target: { value: "Daily sync" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save flow" }).closest("form")!);

  const saved = await screen.findByRole("status");
  expect(saved).toHaveTextContent("저장되었습니다");
  expect(saved).toHaveClass("flow-editor__feedback");
  expect(saved.compareDocumentPosition(screen.getByRole("button", { name: "Save flow" }).parentElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("asks for confirmation before deleting a step that contains SQL", () => {
  render(
    <FlowEditor
      connections={[]}
      initialFlow={{
        id: "daily-sync",
        name: "Daily sync",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [
          { id: "filled", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customer (id) VALUES (:id)" },
          { id: "empty", selectSql: "", upsertSql: "" },
        ],
      }}
      onSave={vi.fn()}
    />,
  );

  const firstStep = screen.getAllByTestId("query-step")[0];
  fireEvent.click(within(firstStep).getByRole("button", { name: "Delete step" }));

  const dialog = screen.getByRole("alertdialog", { name: "쿼리 단계 삭제" });
  expect(screen.getAllByTestId("query-step")).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
  expect(screen.getAllByTestId("query-step")).toHaveLength(1);
});

it("deletes an empty step without asking for confirmation", () => {
  render(
    <FlowEditor
      connections={[]}
      initialFlow={{
        id: "daily-sync",
        name: "Daily sync",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        transactionPolicy: "all_or_nothing",
        version: 1,
        querySteps: [
          { id: "filled", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customer (id) VALUES (:id)" },
          { id: "empty", selectSql: "", upsertSql: "" },
        ],
      }}
      onSave={vi.fn()}
    />,
  );

  const emptyStep = screen.getAllByTestId("query-step")[1];
  fireEvent.click(within(emptyStep).getByRole("button", { name: "Delete step" }));

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("query-step")).toHaveLength(1);
});
