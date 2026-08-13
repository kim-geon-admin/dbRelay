import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { StepPreviewDialog } from "./StepPreviewDialog";

const emptyPreview = { columns: ["ID"], rows: [] };

function ClosablePreview({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? <StepPreviewDialog preview={emptyPreview} onClose={() => {
    setOpen(false);
    onClose();
  }} /> : null;
}

test("renders preview rows in source column order and safely formats special values", () => {
  render(<StepPreviewDialog preview={{
    columns: ["ID", "BIG_ID", "CREATED_AT", "PAYLOAD", "NOTE"],
    rows: [{
      ID: 7,
      BIG_ID: { type: "bigint", decimal: "9007199254740993" },
      CREATED_AT: { year: 2026, month: 8, day: 13, hour: 9, minute: 10, second: 11 },
      PAYLOAD: { type: "bytes", base64: "AQID" },
      NOTE: null,
    }],
  }} onClose={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: "미리보기" })).toHaveAttribute("aria-modal", "true");
  expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "ID", "BIG_ID", "CREATED_AT", "PAYLOAD", "NOTE",
  ]);
  expect(screen.getByRole("cell", { name: "9007199254740993" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "2026-08-13 09:10:11" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "3 bytes" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "NULL" })).toBeVisible();
});

test("shows an empty state and closes from its labelled close button", () => {
  const onClose = vi.fn();
  render(<StepPreviewDialog preview={{ columns: ["ID"], rows: [] }} onClose={onClose} />);

  expect(screen.getByText("미리볼 행이 없습니다.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("moves focus into the dialog, traps Tab, and restores its opener", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const view = render(<StepPreviewDialog preview={emptyPreview} onClose={vi.fn()} />);
  try {
    const close = screen.getByRole("button", { name: "닫기" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
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
