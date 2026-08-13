import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { StepPreviewDialog } from "./StepPreviewDialog";

test("renders preview rows in source column order and safely formats special values", () => {
  render(<StepPreviewDialog preview={{
    columns: ["ID", "CREATED_AT", "PAYLOAD", "NOTE"],
    rows: [{
      ID: 7,
      CREATED_AT: { year: 2026, month: 8, day: 13, hour: 9, minute: 10, second: 11 },
      PAYLOAD: { type: "bytes", base64: "AQID" },
      NOTE: null,
    }],
  }} onClose={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: "미리보기" })).toHaveAttribute("aria-modal", "true");
  expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "ID", "CREATED_AT", "PAYLOAD", "NOTE",
  ]);
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
