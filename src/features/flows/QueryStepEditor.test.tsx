import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { QueryStepEditor } from "./QueryStepEditor";
import type { QueryStep } from "./flows.types";
import { discardEditedPreview, discardStepRestore, previewFlowStep, restoreFlowStep, runFlowStep, saveEditedPreview } from "./flows.api";

vi.mock("./flows.api", () => ({
  previewFlowStep: vi.fn(),
  runFlowStep: vi.fn(),
  saveEditedPreview: vi.fn(),
  discardEditedPreview: vi.fn(),
  discardStepRestore: vi.fn(),
  restoreFlowStep: vi.fn(),
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

test("generates an update guide from the first Source SQL column without target metadata", () => {
  const onChange = vi.fn();
  render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{ id: "step-1", selectSql: "SELECT id, email FROM customers", upsertSql: "" }} onChange={onChange} />);

  fireEvent.change(screen.getByRole("combobox", { name: "Operation for step 1" }), { target: { value: "update" } });

  const targetSql = screen.getByRole("textbox", { name: "Target SQL for step 1" }) as HTMLTextAreaElement;
  expect(targetSql.value).toContain("WHERE id = :id");
  expect(targetSql).not.toBeDisabled();
});

test("generates an upsert guide from the first Source SQL column", () => {
  const onChange = vi.fn();
  render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{ id: "step-1", selectSql: "SELECT id, email FROM customers", upsertSql: "" }} onChange={onChange} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Operation for step 1" }), { target: { value: "upsert" } });
  expect(screen.getByRole("option", { name: "Upsert" })).toBeInTheDocument();
  const guideSql = screen.getByRole("textbox", { name: "Target SQL for step 1" }) as HTMLTextAreaElement;
  expect(guideSql.value).toContain("대상 행 검색 ON 조건으로 사용합니다.");
  expect(guideSql.value).toContain(":id, :email 값은 Source SQL의 SELECT 컬럼 값으로 자동 바인딩됩니다.");
  expect(guideSql.value).toContain("ON (target.id = source.id)");
  expect(screen.getByText("Source SQL의 첫 번째 SELECT 컬럼으로 Target SQL의 ON 조건을 생성합니다. 실제 키 조건에 맞게 수정하세요.")).toBeVisible();
});

test("edits Source and Target SQL through self-contained native textareas", () => {
  render(<StatefulStepEditor initialStep={{
    id: "step-1",
    selectSql: "SELECT id\nFROM customers\nWHERE id = :id",
    upsertSql: "INSERT INTO customers (id)\nVALUES (:id)",
  }} />);

  expect(screen.getByRole("textbox", { name: "Source SQL for step 1" })).toHaveClass("sql-editor");
  expect(screen.getByRole("textbox", { name: "Target SQL for step 1" })).toHaveClass("sql-editor");
  expect(screen.queryByTestId("sql-editor-line-numbers")).not.toBeInTheDocument();
  expect(screen.queryByTestId("sql-editor-highlight")).not.toBeInTheDocument();
});

test("formats only the focused Source SQL when Ctrl+F is pressed", () => {
  render(<StatefulStepEditor initialStep={{
    id: "step-1",
    selectSql: "select id,email from customers where id=:customer_id",
    upsertSql: "insert into customers (id) values (:id)",
  }} />);

  const source = screen.getByRole("textbox", { name: "Source SQL for step 1" });
  source.focus();
  fireEvent.keyDown(source, { key: "f", ctrlKey: true });

  expect(source).toHaveValue("SELECT\n  id,\n  email\nFROM\n  customers\nWHERE\n  id = :customer_id");
  expect(screen.getByRole("textbox", { name: "Target SQL for step 1" })).toHaveValue("insert into customers (id) values (:id)");
});

test("formats only the focused Target SQL when Ctrl+F is pressed", () => {
  render(<StatefulStepEditor initialStep={{
    id: "step-1",
    selectSql: "select id from customers",
    upsertSql: "insert into customers (id,email) values (:id,:email)",
  }} />);

  const target = screen.getByRole("textbox", { name: "Target SQL for step 1" });
  target.focus();
  fireEvent.keyDown(target, { key: "f", ctrlKey: true });

  expect(screen.getByRole("textbox", { name: "Source SQL for step 1" })).toHaveValue("select id from customers");
  expect(target).toHaveValue("INSERT INTO\n  customers (id, email)\nVALUES\n  (:id, :email)");
});

test("renders preview and Run as distinct emphasized actions", () => {
  const { container } = render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{
    id: "step-1",
    selectSql: "SELECT id FROM customers",
    upsertSql: "INSERT INTO customers (id) VALUES (:id)",
  }} />);

  expect(container.querySelector(".query-step__action--preview")).toBeInstanceOf(HTMLButtonElement);
  expect(screen.getByRole("button", { name: "Run" })).toHaveClass("query-step__action--run");
});

test("explains why a visually disabled restore action cannot run", async () => {
  render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{
    id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customers (id) VALUES (:id)",
  }} />);

  const restore = screen.getByRole("button", { name: "복원" });
  expect(restore).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(restore);

  expect(await screen.findByTestId("restore-error-code")).toHaveTextContent("RESTORE_UNAVAILABLE");
  expect(restoreFlowStep).not.toHaveBeenCalled();
});

test("previews the current source SQL and clears the parent preview state when closed", async () => {
  vi.mocked(previewFlowStep).mockResolvedValue({ previewId: "preview-1", columns: ["ID"], rows: [{ ID: 1 }] });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT" }} />);

  fireEvent.click(screen.getByRole("button", { name: "미리보기" }));

  expect(await screen.findByRole("dialog", { name: "미리보기" })).toBeVisible();
  expect(previewFlowStep).toHaveBeenCalledWith({ sourceConnectionId: "source-1", selectSql: "SELECT id FROM customers" });
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByRole("dialog", { name: "미리보기" })).not.toBeInTheDocument();
});

test("shows a preview query error code with its safe message", async () => {
  vi.mocked(previewFlowStep).mockRejectedValue({
    code: "ORA-00942",
    detail: "SELECT password FROM private_source WHERE token = 'not-for-ui'",
  });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT" }} />);

  fireEvent.click(document.querySelector<HTMLButtonElement>(".query-step__action--preview")!);

  const alert = await screen.findByRole("alert");
  expect(screen.getByTestId("preview-error-code")).toHaveTextContent("ORA-00942");
  expect(screen.getByTestId("preview-error-message")).not.toBeEmptyDOMElement();
  expect(alert).not.toHaveTextContent("SELECT password");
  expect(alert).not.toHaveTextContent("not-for-ui");
});

test("saves edited preview rows and discards their token when the editor unmounts", async () => {
  vi.mocked(previewFlowStep).mockResolvedValue({
    previewId: "preview-1",
    columns: ["NAME"],
    rows: [{ NAME: "Ada" }],
  });
  vi.mocked(saveEditedPreview).mockResolvedValue(undefined);
  const view = render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT name FROM customers", upsertSql: "INSERT" }} />);

  fireEvent.click(document.querySelector<HTMLButtonElement>(".query-step__action--preview")!);
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByRole("textbox", { name: "NAME row 1" }), { target: { value: "Lin" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(saveEditedPreview).toHaveBeenCalledWith({
    previewId: "preview-1",
    columns: ["NAME"],
    rows: [{ NAME: "Lin" }],
  });
  view.unmount();
  expect(discardEditedPreview).toHaveBeenCalledWith("preview-1");
});

test("runs the step with its saved preview token without requesting source rows again", async () => {
  vi.mocked(previewFlowStep).mockResolvedValue({
    previewId: "preview-2",
    columns: ["NAME"],
    rows: [{ NAME: "Ada" }],
  });
  vi.mocked(saveEditedPreview).mockResolvedValue(undefined);
  vi.mocked(runFlowStep).mockResolvedValue({ affectedRows: 1 });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT name FROM customers", upsertSql: "INSERT INTO customers (name) VALUES (:NAME)" }} />);

  fireEvent.click(document.querySelector<HTMLButtonElement>(".query-step__action--preview")!);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await screen.findByText("사용자가 변경한 데이터로 DML 처리 합니다");
  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  await expect(runFlowStep).toHaveBeenCalledWith(expect.objectContaining({
    sourceConnectionId: "source-1",
    targetConnectionId: "target-1",
    selectSql: "SELECT name FROM customers",
    upsertSql: "INSERT INTO customers (name) VALUES (:NAME)",
    previewId: "preview-2",
  }));
});

test("disables actions until SQL and connection ids are available", () => {
  const { rerender } = render(<StatefulStepEditor sourceConnectionId="" targetConnectionId="" initialStep={{ id: "step-1", selectSql: "", upsertSql: "" }} />);

  expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

  rerender(<StatefulStepEditor key="ready" sourceConnectionId="same" targetConnectionId="same" initialStep={{ id: "step-1", selectSql: "SELECT 1", upsertSql: "INSERT" }} />);
  expect(screen.getByRole("button", { name: "미리보기" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).not.toBeDisabled();
});

test("runs the current source and target SQL and reports only the localized connector error", async () => {
  vi.mocked(runFlowStep)
    .mockResolvedValueOnce({ affectedRows: 4 })
    .mockRejectedValueOnce({ code: "ORA-00001", detail: "password=not-for-ui" });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customers (id) VALUES (:id)" }} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("status")).toHaveTextContent("4");
  expect(runFlowStep).toHaveBeenCalledWith(expect.objectContaining({
    sourceConnectionId: "source-1",
    targetConnectionId: "target-1",
    selectSql: "SELECT id FROM customers",
    upsertSql: "INSERT INTO customers (id) VALUES (:id)",
  }));

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("ORA-00001");
  expect(alert).not.toHaveTextContent("password=not-for-ui");
});

test("keeps the completed Run restore action available when Source SQL is edited", async () => {
  vi.mocked(runFlowStep).mockResolvedValue({ affectedRows: 1, restoreId: "restore-current-step" });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{
    id: "step-1",
    selectSql: "SELECT 1 USER_ID FROM dual",
    upsertSql: "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID",
  }} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText("1 rows affected.");
  expect(screen.getByRole("button", { name: "복원" })).not.toBeDisabled();

  fireEvent.change(screen.getByRole("textbox", { name: "Source SQL for step 1" }), {
    target: { value: "SELECT 1001 USER_ID FROM dual" },
  });

  expect(screen.getByRole("button", { name: "복원" })).not.toBeDisabled();
  expect(discardStepRestore).not.toHaveBeenCalledWith("restore-current-step");
});

test("keeps the completed Run restore action available when Target SQL is edited", async () => {
  vi.mocked(discardStepRestore).mockClear();
  vi.mocked(runFlowStep).mockResolvedValue({ affectedRows: 1, restoreId: "restore-current-step" });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{
    id: "step-1",
    selectSql: "SELECT 1 USER_ID, 'new' DISPLAY_NAME FROM dual",
    upsertSql: "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID",
  }} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText("1 rows affected.");
  fireEvent.change(screen.getByRole("textbox", { name: "Target SQL for step 1" }), {
    target: { value: "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID -- edited" },
  });

  expect(screen.getByRole("button", { name: "복원" })).toHaveAttribute("aria-disabled", "false");
  expect(discardStepRestore).not.toHaveBeenCalledWith("restore-current-step");
});

test("shows a restore success message beside the affected rows and emphasizes the restore action", async () => {
  vi.mocked(runFlowStep).mockResolvedValue({ affectedRows: 1, restoreId: "restore-current-step" });
  vi.mocked(restoreFlowStep).mockResolvedValue({ affectedRows: 1 });
  render(<StatefulStepEditor sourceConnectionId="source-1" targetConnectionId="target-1" initialStep={{
    id: "step-1",
    selectSql: "SELECT 1 USER_ID FROM dual",
    upsertSql: "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID",
  }} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText("1 rows affected.");
  const restore = screen.getByRole("button", { name: "복원" });
  expect(restore).toHaveClass("query-step__action--restore");

  fireEvent.click(restore);

  expect(await screen.findByText("정상 복원되었습니다.")).toBeVisible();
  expect(restoreFlowStep).toHaveBeenCalledWith("restore-current-step");
});

test("shows Korean named binds in the Target SQL guide", () => {
  render(<StatefulStepEditor initialStep={{
    id: "step-1",
    selectSql: "SELECT \"사용자ID\", \"표시명\" FROM \"사용자\"",
    upsertSql: "UPDATE \"대상사용자\" SET \"표시명\" = :표시명 WHERE \"사용자ID\" = :사용자ID",
  }} />);

  expect(screen.getByText("Target binds: 표시명, 사용자ID")).toBeVisible();
});
