import { describe, expect, it, vi } from "vitest";
import { DB_RELAY_RUN_PROGRESS_CHANNEL } from "./ipc/commands";
import { invokeDbRelayCommand, isAllowedCommand, subscribeRunProgress } from "./preload";

describe("isAllowedCommand", () => {
  it("accepts only DB Relay command names", () => {
    expect(isAllowedCommand("list_connections")).toBe(true);
    expect(isAllowedCommand("preview_flow_step")).toBe(true);
    expect(isAllowedCommand("save_edited_preview")).toBe(true);
    expect(isAllowedCommand("discard_edited_preview")).toBe(true);
    expect(isAllowedCommand("run_flow_step")).toBe(true);
    expect(isAllowedCommand("delete_run_history")).toBe(true);
    expect(isAllowedCommand("execute_arbitrary_sql")).toBe(false);
  });

  it("forwards the two typed current-step commands through the allowlist", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { previewId: "preview-1", columns: ["ID"], rows: [{ ID: 1 }] } })
      .mockResolvedValueOnce({ ok: true, value: { affectedRows: 1 } });

    await expect(invokeDbRelayCommand(invoke, "preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT id FROM t" },
    })).resolves.toEqual({ previewId: "preview-1", columns: ["ID"], rows: [{ ID: 1 }] });
    await expect(invokeDbRelayCommand(invoke, "run_flow_step", {
      request: {
        sourceConnectionId: "source", targetConnectionId: "target",
        selectSql: "SELECT id FROM t", upsertSql: "MERGE INTO target USING dual ON (id = :ID)",
      },
    })).resolves.toEqual({ affectedRows: 1 });
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

  it("subscribes only to valid fixed-channel batch progress and removes its listener", () => {
    // Would fail if preload exposed a generic event API, forwarded malformed
    // payloads, or leaked the listener after the renderer unsubscribed.
    let registered: ((event: unknown, progress: unknown) => void) | undefined;
    const ipcRenderer = {
      on: vi.fn((_channel: string, listener: (event: unknown, progress: unknown) => void) => {
        registered = listener;
      }),
      removeListener: vi.fn(),
    };
    const receive = vi.fn();

    const unsubscribe = subscribeRunProgress(ipcRenderer, receive);
    registered?.({}, {
      runId: "run-1", step: 0, processedRows: 1_000, totalRows: 2_001,
      completedBatches: 1, totalBatches: 3,
    });
    registered?.({}, { runId: "run-1", processedRows: 1_000 });

    expect(ipcRenderer.on).toHaveBeenCalledWith(DB_RELAY_RUN_PROGRESS_CHANNEL, expect.any(Function));
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({
      runId: "run-1", step: 0, processedRows: 1_000, totalRows: 2_001,
      completedBatches: 1, totalBatches: 3,
    });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      DB_RELAY_RUN_PROGRESS_CHANNEL,
      expect.any(Function),
    );
  });
});
