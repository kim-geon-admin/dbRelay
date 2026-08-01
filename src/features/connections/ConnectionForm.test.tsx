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

  const password = screen.getByLabelText("Password");
  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveValue("********");
  expect(screen.queryByLabelText("Encrypt password storage")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Source account is read-only")).not.toBeInTheDocument();
});

it("keeps the mask on focus and submits a directly typed plaintext replacement", () => {
  const onSave = vi.fn();
  render(<ConnectionForm connection={{
    id: "production", displayName: "Production", kind: "oracle", host: "db.example.test", port: 1521,
    serviceName: "ORCLPDB1", username: "relay", passwordMask: "********", enabled: true,
  }} onSave={onSave} />);

  const password = screen.getByLabelText("Password") as HTMLInputElement;
  fireEvent.focus(password);

  expect(password).toHaveValue("********");
  expect(password.selectionStart).toBe(0);
  expect(password.selectionEnd).toBe(8);

  fireEvent.change(password, { target: { value: "new-plaintext-password" } });

  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveValue("new-plaintext-password");
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: "new-plaintext-password" }));
});
