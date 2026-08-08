import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { QueryStepEditor } from "./QueryStepEditor";
import type { QueryStep } from "./flows.types";

function StatefulStepEditor({ initialStep, onChange = vi.fn() }: { initialStep: QueryStep; onChange?: (step: QueryStep) => void }) {
  const [step, setStep] = useState(initialStep);
  const update = (next: QueryStep) => { onChange(next); setStep(next); };
  return <QueryStepEditor step={step} position={0} total={1} onChange={update} onDelete={vi.fn()} onMove={vi.fn()} />;
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
    upsertSql: "-- Review the WHERE clause and use the target table primary key.\nUPDATE customers\nSET\n  email = :email\nWHERE id = :id",
  });
  expect(screen.getByRole("textbox", { name: "Target SQL for step 1" })).not.toBeDisabled();
});
