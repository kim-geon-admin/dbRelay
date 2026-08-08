import { describe, expect, it, vi } from "vitest";
import { invokeDbRelayCommand, isAllowedCommand } from "./preload";

describe("isAllowedCommand", () => {
  it("accepts only DB Relay command names", () => {
    expect(isAllowedCommand("list_connections")).toBe(true);
    expect(isAllowedCommand("execute_arbitrary_sql")).toBe(false);
  });

  it("unwraps a successful main-process response", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: [] });

    await expect(invokeDbRelayCommand(invoke, "list_connections"))
      .resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("db-relay:invoke", "list_connections", undefined);
  });

  it("rejects an unavailable command before crossing IPC", async () => {
    const invoke = vi.fn();

    await expect(invokeDbRelayCommand(invoke, "execute_arbitrary_sql", { sql: "select 1" }))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "The requested command is not available.",
        code: "COMMAND_NOT_ALLOWED",
      });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects with the structured error returned by main", async () => {
    const error = {
      title: "Invalid request",
      detail: "password=[REDACTED]",
      code: "INVALID_REQUEST",
      password: "private",
    };
    const invoke = vi.fn().mockResolvedValue({ ok: false, error });

    await expect(invokeDbRelayCommand(invoke, "list_connections"))
      .rejects.toEqual({
        title: "Invalid request",
        detail: "password=[REDACTED]",
        code: "INVALID_REQUEST",
      });
  });

  it("replaces transport failures with a fixed structured error", async () => {
    const invoke = vi.fn().mockRejectedValue(
      new Error("SELECT secret FROM source; password=hunter2; rows=[private]"),
    );

    await expect(invokeDbRelayCommand(invoke, "list_connections"))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "The application command channel is unavailable.",
        code: "IPC_UNAVAILABLE",
      });
  });
});
