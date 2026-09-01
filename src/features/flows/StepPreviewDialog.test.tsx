import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { StepPreviewDialog } from "./StepPreviewDialog";

const emptyPreview = { previewId: "preview-empty", columns: ["ID"], rows: [] };

function ClosablePreview({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? <StepPreviewDialog preview={emptyPreview} onClose={() => {
    setOpen(false);
    onClose();
  }} /> : null;
}

test("renders preview rows in source column order and safely formats special values", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-special-values",
    columns: ["ID", "BIG_ID", "CREATED_ON", "CREATED_AT", "PAYLOAD", "NOTE"],
    rows: [{
      ID: 7,
      BIG_ID: { type: "bigint", decimal: "9007199254740993" },
      CREATED_ON: { year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25 },
      CREATED_AT: {
        year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
        microsecond: 123_456, tzHourOffset: 0, tzMinuteOffset: 0,
      },
      PAYLOAD: { type: "bytes", base64: "AQID" },
      NOTE: null,
    }],
  }} onClose={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: "미리보기" })).toHaveAttribute("aria-modal", "true");
  const columnHeaders = screen.getAllByRole("columnheader").map((header) => header.textContent);
  expect(columnHeaders[0]).toBe("#");
  expect(columnHeaders.slice(1)).toEqual([
    "ID", "BIG_ID", "CREATED_ON", "CREATED_AT", "PAYLOAD", "NOTE",
  ]);
  expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["1"]);
  expect(screen.getByRole("textbox", { name: "BIG_ID row 1" })).toHaveValue("9007199254740993");
  expect(screen.getByRole("textbox", { name: "CREATED_ON row 1" })).toHaveValue("2026-09-01 14:30:25");
  expect(screen.getByRole("textbox", { name: "CREATED_AT row 1" })).toHaveValue("2026-09-01 14:30:25.123456");
  expect(screen.getByRole("textbox", { name: "PAYLOAD row 1" })).toHaveValue("AQID");
  expect(screen.getByRole("textbox", { name: "NOTE row 1" })).toHaveValue("");
});

test("shows an empty state and closes from its labelled close button", () => {
  const onClose = vi.fn();
  render(<StepPreviewDialog preview={{ previewId: "preview-empty", columns: ["ID"], rows: [] }} onClose={onClose} />);

  expect(screen.getByText("미리볼 행이 없습니다.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("keeps preview table scrolling inside the modal", () => {
  render(<StepPreviewDialog preview={{ previewId: "preview-scroll", columns: ["ID"], rows: [{ ID: 1 }] }} onClose={vi.fn()} />);

  expect(screen.getByTestId("step-preview-table-scroll")).toBeVisible();
});

test("edits string cells and saves the changed preview rows", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-editable",
    columns: ["ID", "NAME"],
    rows: [{ ID: 7, NAME: "Ada" }],
  }} onClose={vi.fn()} onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "NAME row 1" }), { target: { value: "Lin" } });
  fireEvent.blur(screen.getByRole("textbox", { name: "NAME row 1" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(onSave).toHaveBeenCalledWith({
    columns: ["ID", "NAME"],
    rows: [{ ID: 7, NAME: "Lin" }],
  });
});

test("saves edited DATE and TIMESTAMP preview cells as their Oracle bind values", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-temporal-edit",
    columns: ["CREATED_ON", "CREATED_AT"],
    rows: [{
      CREATED_ON: { year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25 },
      CREATED_AT: {
        year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
        microsecond: 0, tzHourOffset: 0, tzMinuteOffset: 0,
      },
    }],
  }} onClose={vi.fn()} onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "CREATED_ON row 1" }), { target: { value: "2026-10-02 03:04:05" } });
  fireEvent.change(screen.getByRole("textbox", { name: "CREATED_AT row 1" }), { target: { value: "2026-10-02 03:04:05.123456" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(onSave).toHaveBeenCalledWith({
    columns: ["CREATED_ON", "CREATED_AT"],
    rows: [{
      CREATED_ON: { year: 2026, month: 10, day: 2, hour: 3, minute: 4, second: 5 },
      CREATED_AT: {
        year: 2026, month: 10, day: 2, hour: 3, minute: 4, second: 5,
        microsecond: 123_456, tzHourOffset: 0, tzMinuteOffset: 0,
      },
    }],
  });
});

test("renders all cells in edit mode and marks a numeric cell changed", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-number",
    columns: ["ID"],
    rows: [{ ID: 7 }],
  }} onClose={vi.fn()} onSave={onSave} />);

  const cell = screen.getByTestId("preview-cell-0-ID");
  expect(screen.getByRole("textbox", { name: "ID row 1" })).toHaveValue("7");
  fireEvent.change(screen.getByRole("textbox", { name: "ID row 1" }), { target: { value: "8" } });
  fireEvent.blur(screen.getByRole("textbox", { name: "ID row 1" }));

  expect(cell).toHaveClass("step-preview-dialog__cell--changed");
  fireEvent.click(document.querySelector<HTMLButtonElement>(".step-preview-dialog__header button")!);
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ columns: ["ID"], rows: [{ ID: "8" }] }));
});

test("saves a non-empty edit without comparing it to the original cell type", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-type-free",
    columns: ["ID"],
    rows: [{ ID: 7 }],
  }} onClose={vi.fn()} onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "ID row 1" }), { target: { value: "custom-id" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(onSave).toHaveBeenCalledWith({ columns: ["ID"], rows: [{ ID: "custom-id" }] });
  expect(screen.queryByText("The value must keep its original type.")).not.toBeInTheDocument();
});

test("saves an empty edited cell as null", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{
    previewId: "preview-empty-cell",
    columns: ["NAME"],
    rows: [{ NAME: "Ada" }],
  }} onClose={vi.fn()} onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "NAME row 1" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await expect(onSave).toHaveBeenCalledWith({ columns: ["NAME"], rows: [{ NAME: null }] });
});

test("fills the rows below a numeric header's first value after confirmation", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-auto-number",
    columns: ["ID"],
    rows: [{ ID: 1000 }, { ID: 4 }, { ID: 9 }, { ID: 12 }],
  }} onClose={vi.fn()} onSave={vi.fn()} />);

  fireEvent.doubleClick(screen.getByRole("columnheader", { name: "ID" }));

  expect(screen.getByRole("alertdialog", { name: "컬럼 자동 채우기" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "자동 채우기" }));

  expect(screen.getByRole("textbox", { name: "ID row 1" })).toHaveValue("1000");
  expect(screen.getByRole("textbox", { name: "ID row 2" })).toHaveValue("1001");
  expect(screen.getByRole("textbox", { name: "ID row 3" })).toHaveValue("1002");
  expect(screen.getByRole("textbox", { name: "ID row 4" })).toHaveValue("1003");
});

test("appends a sequential suffix to each string row after confirmation", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-auto-string",
    columns: ["CODE"],
    rows: [{ CODE: "abc" }, { CODE: "def" }, { CODE: "ghi" }],
  }} onClose={vi.fn()} onSave={vi.fn()} />);

  fireEvent.doubleClick(screen.getByRole("columnheader", { name: "CODE" }));
  fireEvent.click(screen.getByRole("button", { name: "자동 채우기" }));

  expect(screen.getByRole("textbox", { name: "CODE row 1" })).toHaveValue("abc1");
  expect(screen.getByRole("textbox", { name: "CODE row 2" })).toHaveValue("def2");
  expect(screen.getByRole("textbox", { name: "CODE row 3" })).toHaveValue("ghi3");
});

test("leaves preview values unchanged when column auto-fill is cancelled", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-auto-cancel",
    columns: ["ID"],
    rows: [{ ID: 1000 }, { ID: 4 }],
  }} onClose={vi.fn()} onSave={vi.fn()} />);

  fireEvent.doubleClick(screen.getByRole("columnheader", { name: "ID" }));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));

  expect(screen.getByRole("textbox", { name: "ID row 1" })).toHaveValue("1000");
  expect(screen.getByRole("textbox", { name: "ID row 2" })).toHaveValue("4");
});

test("copies the first row into appended rows when the # header is used", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-row-copy",
    columns: ["ID", "NAME"],
    rows: [{ ID: 1000, NAME: "Ada" }, { ID: 1001, NAME: "Lin" }],
  }} onClose={vi.fn()} onSave={vi.fn()} />);

  fireEvent.doubleClick(screen.getByRole("columnheader", { name: "#" }));
  expect(screen.getByRole("alertdialog", { name: "데이터 행 생성" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("생성할 개수"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));

  expect(screen.getByRole("textbox", { name: "ID row 3" })).toHaveValue("1000");
  expect(screen.getByRole("textbox", { name: "NAME row 3" })).toHaveValue("Ada");
  expect(screen.getByRole("textbox", { name: "ID row 4" })).toHaveValue("1000");
  expect(screen.getByRole("textbox", { name: "NAME row 4" })).toHaveValue("Ada");
  expect(screen.getByTestId("preview-cell-2-ID")).toHaveClass("step-preview-dialog__cell--changed");
  expect(screen.getByTestId("preview-cell-2-NAME")).toHaveClass("step-preview-dialog__cell--changed");
  expect(screen.getByTestId("preview-cell-3-ID")).toHaveClass("step-preview-dialog__cell--changed");
  expect(screen.getByTestId("preview-cell-3-NAME")).toHaveClass("step-preview-dialog__cell--changed");
});

test("does not append rows when # header generation is cancelled", () => {
  render(<StepPreviewDialog preview={{
    previewId: "preview-row-copy-cancel",
    columns: ["ID"],
    rows: [{ ID: 1000 }],
  }} onClose={vi.fn()} onSave={vi.fn()} />);

  fireEvent.doubleClick(screen.getByRole("columnheader", { name: "#" }));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));

  expect(screen.queryByRole("textbox", { name: "ID row 2" })).not.toBeInTheDocument();
});

test("places Save immediately to the left of Close", () => {
  render(<StepPreviewDialog preview={emptyPreview} onClose={vi.fn()} onSave={vi.fn()} />);

  const header = document.querySelector(".step-preview-dialog__header")!;
  expect(header.firstElementChild).toHaveTextContent("저장");
  expect(header.lastElementChild).toHaveTextContent("닫기");
});

test("moves focus into the dialog, traps Tab, and restores its opener", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const view = render(<StepPreviewDialog preview={emptyPreview} onClose={vi.fn()} />);
  try {
    const close = screen.getByRole("button", { name: "닫기" });
    expect(close).toHaveFocus();

    const save = document.querySelector<HTMLButtonElement>(".step-preview-dialog__header button")!;
    fireEvent.keyDown(close, { key: "Tab" });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();

    view.unmount();
    expect(opener).toHaveFocus();
  } finally {
    view.unmount();
    opener.remove();
  }
});

test("closes on Escape and restores the previous body scroll setting", () => {
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "scroll";
  const onClose = vi.fn();
  const view = render(<ClosablePreview onClose={onClose} />);
  try {
    expect(document.body).toHaveStyle({ overflow: "hidden" });

    fireEvent.keyDown(screen.getByRole("dialog", { name: "미리보기" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "미리보기" })).not.toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: "scroll" });
  } finally {
    view.unmount();
    document.body.style.overflow = previousOverflow;
  }
});
