import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ConnectionForm } from "./ConnectionForm";

it("marks the connection editor for scoped responsive layout", () => {
  render(<ConnectionForm onSave={vi.fn()} />);

  expect(screen.getByRole("button", { name: "Save connection" }).closest("form"))
    .toHaveClass("connection-form");
});

it("does not submit a connection with an empty SID", () => {
  const onSave = vi.fn();

  render(<ConnectionForm onSave={onSave} />);

  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Production" } });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.example.test" } });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1521" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "relay" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

  expect(screen.getByText("SID is required.")).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
});

it("submits an SID", () => {
  const onSave = vi.fn();

  render(<ConnectionForm connection={{
    id: "production", displayName: "Production", kind: "oracle", host: "db.example.test", port: 1521,
    sid: "ORCL", username: "relay", passwordMask: "********", enabled: true,
  }} onSave={onSave} />);

  fireEvent.change(screen.getByLabelText("SID"), { target: { value: "ORCL2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

  expect(onSave).toHaveBeenCalledWith({
    id: "production",
    displayName: "Production",
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "ORCL2",
    username: "relay",
    enabled: true,
  });
});

it("shows a saved password as stars without a checkbox", () => {
  render(<ConnectionForm connection={{
    id: "production", displayName: "Production", kind: "oracle", host: "db.example.test", port: 1521,
    sid: "ORCL", username: "relay", credentialStorage: "keyring", passwordMask: "********", enabled: true,
  } as never} onSave={vi.fn()} />);

  const password = screen.getByLabelText("Password");
  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveValue("********");
  expect(screen.queryByLabelText("Encrypt password storage")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Source account is read-only")).not.toBeInTheDocument();
});

it("places the caret after the password mask on focus", () => {
  const onSave = vi.fn();
  render(<ConnectionForm connection={{
    id: "production", displayName: "Production", kind: "oracle", host: "db.example.test", port: 1521,
    sid: "ORCL", username: "relay", passwordMask: "********", enabled: true,
  }} onSave={onSave} />);

  const password = screen.getByLabelText("Password") as HTMLInputElement;
  fireEvent.focus(password);

  expect(password).toHaveValue("********");
  expect(password.selectionStart).toBe(8);
  expect(password.selectionEnd).toBe(8);

  fireEvent.change(password, { target: { value: "new-plaintext-password" } });

  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveValue("new-plaintext-password");
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: "new-plaintext-password" }));
});
