import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ConnectionForm } from "./ConnectionForm";

it("does not submit a connection with an empty service name", () => {
  const onSave = vi.fn();

  render(<ConnectionForm onSave={onSave} />);

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Production" } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.test" } });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1521" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "relay" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

  expect(screen.getByText("Service name is required.")).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
});

it("shows a saved password as stars without a checkbox", () => {
  render(<ConnectionForm connection={{
    id: "production", displayName: "Production", kind: "oracle", host: "db.example.test", port: 1521,
    serviceName: "ORCLPDB1", username: "relay", credentialStorage: "keyring", passwordMask: "********", enabled: true,
  } as never} onSave={vi.fn()} />);

  expect(screen.getByLabelText("Password")).toHaveValue("********");
  expect(screen.queryByLabelText("Encrypt password storage")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Source account is read-only")).not.toBeInTheDocument();
});
