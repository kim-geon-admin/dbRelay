import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open confirmation</button>{open ? <ConfirmDialog title="DB 설정 삭제" description="이 작업은 되돌릴 수 없습니다." confirmLabel="삭제" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)} /> : null}</>;
}

it("cancels with Escape and restores focus to the opener", () => {
  render(<DialogExample />);
  const opener = screen.getByRole("button", { name: "Open confirmation" });

  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("alertdialog", { name: "DB 설정 삭제" });
  expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();

  fireEvent.keyDown(dialog, { key: "Escape" });

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
