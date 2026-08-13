import { fireEvent, render, screen } from "@testing-library/react";
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

it("uses Korean labels for transaction policies", () => {
  render(<FlowEditor connections={[]} onSave={vi.fn()} />);

  expect(screen.getByRole("option", { name: "전체 롤백" })).toHaveValue("all_or_nothing");
  expect(screen.getByRole("option", { name: "성공한 부분까지 커밋" })).toHaveValue("commit_successes");
});
