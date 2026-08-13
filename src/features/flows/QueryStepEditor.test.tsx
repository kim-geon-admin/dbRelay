import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { QueryStepEditor } from "./QueryStepEditor";
import type { QueryStep } from "./flows.types";
import { previewFlowStep, runFlowStep } from "./flows.api";

vi.mock("./flows.api", () => ({
  previewFlowStep: vi.fn(),
  runFlowStep: vi.fn(),
}));

function StatefulStepEditor({
  initialStep,
  onChange = vi.fn(),
  sourceConnectionId,
  targetConnectionId,
}: {
  initialStep: QueryStep;
  onChange?: (step: QueryStep) => void;
  sourceConnectionId?: string;
  targetConnectionId?: string;
}) {
  const [step, setStep] = useState(initialStep);
  const update = (next: QueryStep) => { onChange(next); setStep(next); };
  return <QueryStepEditor step={step} position={0} total={1} sourceConnectionId={sourceConnectionId} targetConnectionId={targetConnectionId} onChange={update} onDelete={vi.fn()} onMove={vi.fn()} />;
}

test("generates an editable target SQL statement for an insert step", () => {
  const onChange = vi.fn();
  render(<StatefulStepEditor initialStep={{ id: "step-1", selectSql: "", upsertSql: "" }} onChange={onChange} />);

  const targetSql = screen.getByRole("textbox", { name: "Target SQL for step 1" });
  expect(targetSql).not.toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Source SQL for step 1" }), { target: { value: "SELECT id, email FROM customers" } });

  expect(onChange).toHaveBeenCalledWith({
    id: "step-1",
    operation: "insert",
    selectSql: "SELECT id, email FROM customers",
    upsertSql: "INSERT INTO customers (id, email)\nVALUES (:id, :email)",
  });
});

test("shows an editable update example when the operation changes to update", () => {
  const onChange = vi.fn();
  render(<StatefulStepEditor initialStep={{ id: "step-1", selectSql: "SELECT id, email FROM customers", upsertSql: "" }} onChange={onChange} />);

  fireEvent.change(screen.getByRole("combobox", { name: "Operation for step 1" }), { target: { value: "update" } });

  expect(onChange).toHaveBeenCalledWith({
    id: "step-1",
    operation: "update",
    selectSql: "SELECT id, email FROM customers",
    upsertSql: "-- 생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오\nUPDATE customers\nSET\n  email = :email\nWHERE id = :id",
  });
  expect(screen.getByRole("textbox", { name: "Target SQL for step 1" })).not.toBeDisabled();
});

test("highlights SQL keywords without rendering a line-number gutter", () => {
  render(<StatefulStepEditor initialStep={{
    id: "step-1",
    selectSql: "SELECT id\nFROM customers\nWHERE id = :id",
    upsertSql: "INSERT INTO customers (id)\nVALUES (:id)",
  }} />);

  expect(screen.queryByTestId("sql-editor-line-numbers")).not.toBeInTheDocument();
  const keyword = screen.getAllByTestId("sql-editor-highlight")[0].querySelector(".sql-token--keyword");
  expect(keyword).toHaveTextContent("SELECT");
  expect(keyword).toHaveClass("sql-token--keyword");
});

test("previews the current source SQL and clears the parent preview state when closed", async () => {
  vi.mocked(previewFlowStep).mockResolvedValue({ columns: ["ID"], rows: [{ ID: 1 }] });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT" }} />);

  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));

  expect(await screen.findByRole("dialog", { name: "미리보기" })).toBeVisible();
  expect(previewFlowStep).toHaveBeenCalledWith({ sourceConnectionId: "source-1", selectSql: "SELECT id FROM customers" });
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("dialog", { name: "미리보기" })).not.toBeInTheDocument();
});

test("disables actions until SQL and required distinct connection ids are available", () => {
  const { rerender } = render(<StatefulStepEditor sourceConnectionId="" targetConnectionId="" initialStep={{ id: "step-1", selectSql: "", upsertSql: "" }} />);

  expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

  rerender(<StatefulStepEditor key="ready" sourceConnectionId="same" targetConnectionId="same" initialStep={{ id: "step-1", selectSql: "SELECT 1", upsertSql: "INSERT" }} />);
  expect(screen.getByRole("button", { name: "미리보기" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

test("runs the current source and target SQL and reports only the localized connector error", async () => {
  vi.mocked(runFlowStep)
    .mockResolvedValueOnce({ affectedRows: 4 })
    .mockRejectedValueOnce({ code: "ORA-00001", detail: "password=not-for-ui" });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customers (id) VALUES (:id)" }} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("status")).toHaveTextContent("4");
  expect(runFlowStep).toHaveBeenCalledWith({
    sourceConnectionId: "source-1",
    targetConnectionId: "target-1",
    selectSql: "SELECT id FROM customers",
    upsertSql: "INSERT INTO customers (id) VALUES (:id)",
  });

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("ORA-00001");
  expect(alert).not.toHaveTextContent("password=not-for-ui");
});
