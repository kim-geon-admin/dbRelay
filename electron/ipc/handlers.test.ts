import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoryService } from "../application/historyService";
import { MigrationRunner, MigrationRunnerError } from "../application/migrationRunner";
import { FlowService } from "../application/flowService";
import { SettingsService } from "../application/settingsService";
import { ConnectorRegistry } from "../connectors/registry";
import type { DatabaseConnectorFactory } from "../connectors/databaseConnector";
import type { ConnectionProfile, Flow } from "../domain/models";
import { RunState } from "../domain/runState";
import { SqliteRepository } from "../infrastructure/sqliteRepository";
import type { DbRelayIpcResult } from "./commands";
import {
  createDbRelayCommandHandler,
  type DbRelayServices,
  isTrustedIpcSender,
  registerDbRelayIpc,
} from "./handlers";

const repositories: SqliteRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
});

describe("DB Relay command handler", () => {
  it("lists connections through the settings service", async () => {
    const { handler } = fixture();

    await expect(handler("list_connections")).resolves.toEqual([]);
  });

  it("saves an imported flow immediately when its connections are available", async () => {
    const { services } = fixture();
    const importedFlow: Flow = {
      id: "imported-flow",
      name: "Imported daily",
      sourceConnectionId: "source",
      targetConnectionId: "target",
      querySteps: [{
        id: "step-1",
        selectSql: "SELECT id FROM source_table",
        upsertSql: "INSERT INTO target_table (id) VALUES (:id)",
      }],
      transactionPolicy: "all_or_nothing",
      version: 0,
    };
    const handler = createDbRelayCommandHandler({
      ...services,
      flows: {
        ...services.flows,
        saveFlow: async (flow) => ({ ...flow, version: 1 }),
      },
      flowTransfer: {
        exportFlow: async () => false,
        importFlow: async () => ({ kind: "ready", flow: importedFlow }),
      },
    });

    await expect(handler("import_flow")).resolves.toEqual({
      status: "saved",
      flow: { ...importedFlow, version: 1 },
    });
  });

  it("returns run-time database and flow names with history entries", async () => {
    const { handler, repository } = fixtureWithReferencedConnection();
    repository.createBoundRun("run-daily", RunState.running("all_or_nothing", 0), {
      flow: repository.loadFlow("daily")!,
      sourceProfile: repository.loadConnection("source")!,
      targetProfile: repository.loadConnection("target")!,
    });

    await expect(handler("list_run_history")).resolves.toEqual([
      expect.objectContaining({
        runId: "run-daily",
        flowId: "daily",
        flowName: "Daily",
        sourceDbName: "source",
        targetDbName: "target",
      }),
    ]);
  });

  it("deletes a terminal run through the typed history command", async () => {
    const { handler, repository } = fixture();
    repository.createRun("completed-run", RunState.running("all_or_nothing", 0));

    await expect(handler("delete_run_history", {
      request: { runId: "completed-run" },
    })).resolves.toBeUndefined();
    await expect(handler("list_run_history")).resolves.toEqual([]);
  });

  it("deletes a saved flow through the typed flow command", async () => {
    const { handler, repository } = fixtureWithReferencedConnection();

    await expect(handler("delete_flow", {
      request: { flowId: "daily" },
    })).resolves.toBeUndefined();
    expect(repository.loadFlow("daily")).toBeUndefined();
  });

  it("rejects commands outside the main-process allowlist", async () => {
    const { handler } = fixture();

    await expect(handler("execute_arbitrary_sql", { sql: "select 1" }))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "The requested command is not available.",
        code: "COMMAND_NOT_ALLOWED",
      });
  });

  it("returns a password mask without serializing plaintext connection fields", async () => {
    const { handler, repository } = fixture();
    repository.saveConnection({
      id: "production",
      displayName: "Production",
      kind: "oracle",
      host: "db.example.test",
      port: 1521,
      sid: "XE",
      username: "relay",
      credentialRef: "production",
      credentialStorage: "plaintext",
      plaintextPassword: "s3cret",
      enabled: true,
      sourceReadOnly: false,
    });

    const response = await handler("list_connections");

    expect(response).toEqual([
      {
        id: "production",
        displayName: "Production",
        kind: "oracle",
        host: "db.example.test",
        port: 1521,
        sid: "XE",
        username: "relay",
        passwordMask: "******",
        enabled: true,
      },
    ]);
    expect(JSON.stringify(response)).not.toContain("s3cret");
    expect(response[0]).not.toHaveProperty("plaintextPassword");
    expect(response[0]).not.toHaveProperty("credentialRef");
  });

  it("accepts exact preview and current-step requests", async () => {
    // Would fail if either dedicated command was absent, accepted a forged request,
    // or dispatched a current step through an unrelated run operation.
    const { handler, services } = fixture();
    const previewFlowStep = vi.spyOn(services.runs, "previewFlowStep").mockResolvedValue({
      previewId: "preview-current-step",
      columns: ["ID"],
      rows: [{ ID: 1 }],
    });
    const runFlowStep = vi.spyOn(services.runs, "runFlowStep").mockResolvedValue({ affectedRows: 1 });

    await expect(handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT id FROM t" },
    })).resolves.toEqual({ previewId: "preview-current-step", columns: ["ID"], rows: [{ ID: 1 }] });
    await expect(handler("run_flow_step", {
      request: {
        sourceConnectionId: "source",
        targetConnectionId: "target",
        selectSql: "SELECT id FROM t",
        upsertSql: "MERGE INTO target USING dual ON (id = :ID)",
      },
    })).resolves.toEqual({ affectedRows: 1 });
    await expect(handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT 1", extra: true },
    } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(previewFlowStep).toHaveBeenCalledWith({
      sourceConnectionId: "source",
      selectSql: "SELECT id FROM t",
    });
    expect(runFlowStep).toHaveBeenCalledWith({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM t",
      upsertSql: "MERGE INTO target USING dual ON (id = :ID)",
    });
  });

  it("forwards only safe batch progress from a started run", async () => {
    // Would fail if a run progress callback was not wired through the typed
    // handler or if the handler forwarded source/target execution details.
    const { services } = fixture();
    const emitProgress = vi.fn();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async (_flowId: string, onProgress?: (progress: unknown) => void) => {
          onProgress?.({
            runId: "run-progress", step: 0, processedRows: 1_000, totalRows: 2_001,
            completedBatches: 1, totalBatches: 3, rows: [{ password: "private" }],
          });
          return { runId: "run-progress", policy: "all_or_nothing", status: "completed", steps: [], events: [] };
        },
      } as never,
    }, emitProgress);

    await handler("start_run", { request: { flowId: "flow-1" } });

    expect(emitProgress).toHaveBeenCalledWith({
      runId: "run-progress", step: 0, processedRows: 1_000, totalRows: 2_001,
      completedBatches: 1, totalBatches: 3,
    });
    const progress = emitProgress.mock.calls[0][0] as Record<string, unknown>;
    expect(progress).not.toHaveProperty("rows");
    expect(progress).not.toHaveProperty("password");
    expect(JSON.stringify(progress)).not.toContain("private");
  });

  it("accepts editable preview rows only through the dedicated save and discard commands", async () => {
    // Would fail if editable source rows could use a generic command, if their
    // preview token was omitted, if the main process received DTO cells without
    // converting them back to application values, or if an unusable cell blocked
    // the save instead of the run.
    const { services } = fixture();
    const saveEditedPreview = vi.fn();
    const discardEditedPreview = vi.fn();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        saveEditedPreview,
        discardEditedPreview,
      } as never,
    });

    await expect(handler("save_edited_preview", {
      request: {
        previewId: "preview-1",
        columns: ["ID", "NAME"],
        rows: [{ ID: 7, NAME: "edited" }],
      },
    } as never)).resolves.toBeUndefined();
    await expect(handler("discard_edited_preview", {
      request: { previewId: "preview-1" },
    } as never)).resolves.toBeUndefined();
    await expect(handler("save_edited_preview", {
      request: {
        previewId: "preview-1",
        columns: ["ID", "NAME", "MEMO"],
        rows: [{
          ID: Number.POSITIVE_INFINITY,
          MEMO: { type: "bigint", decimal: "not-a-number" },
        }],
      },
    } as never)).resolves.toBeUndefined();
    await expect(handler("save_edited_preview", {
      request: { previewId: "preview-1", columns: ["ID", "ID"], rows: [{ ID: 7 }] },
    } as never)).resolves.toBeUndefined();
    await expect(handler("save_edited_preview", {
      request: { previewId: "preview-1", columns: ["ID", "NAME"], rows: ["not-a-row"] },
    } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(saveEditedPreview).toHaveBeenNthCalledWith(1, {
      previewId: "preview-1",
      columns: ["ID", "NAME"],
      rows: [{ ID: 7, NAME: "edited" }],
    });
    expect(saveEditedPreview).toHaveBeenNthCalledWith(2, {
      previewId: "preview-1",
      columns: ["ID", "NAME", "MEMO"],
      rows: [{ ID: "Infinity", MEMO: "not-a-number" }],
    });
    expect(discardEditedPreview).toHaveBeenCalledWith("preview-1");
  });

  it("projects preview values to lossless JSON-safe cells", async () => {
    // Would fail if binary values, structured Oracle temporal values, or nested
    // JSON-safe preview values crossed IPC in a driver-specific shape.
    const { handler, services } = fixture();
    vi.spyOn(services.runs, "previewFlowStep").mockResolvedValue({
      previewId: "preview-projection",
      columns: ["BIG_ID", "DATE_VALUE", "TIMESTAMP_VALUE", "BYTES", "NESTED"],
      rows: [{
        BIG_ID: 9_007_199_254_740_993n,
        DATE_VALUE: { year: 2026, month: 8, day: 13, hour: 10, minute: 11, second: 12 },
        TIMESTAMP_VALUE: {
          year: 2026, month: 8, day: 13, hour: 10, minute: 11, second: 12,
          microsecond: 123_456, tzHourOffset: 9, tzMinuteOffset: 0,
        },
        BYTES: new Uint8Array([0, 255]),
        NESTED: { value: [true, null, "safe"] },
      } as never],
    });

    await expect(handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT value FROM t" },
    })).resolves.toEqual({
      previewId: "preview-projection",
      columns: ["BIG_ID", "DATE_VALUE", "TIMESTAMP_VALUE", "BYTES", "NESTED"],
      rows: [{
        BIG_ID: { type: "bigint", decimal: "9007199254740993" },
        DATE_VALUE: { year: 2026, month: 8, day: 13, hour: 10, minute: 11, second: 12 },
        TIMESTAMP_VALUE: {
          year: 2026, month: 8, day: 13, hour: 10, minute: 11, second: 12,
          microsecond: 123_456, tzHourOffset: 9, tzMinuteOffset: 0,
        },
        BYTES: { type: "bytes", base64: "AP8=" },
        NESTED: { value: [true, null, "safe"] },
      }],
    });
  });

  it("rejects unsupported preview values without exposing their contents", async () => {
    // Would fail if an unsupported source value was serialized or its raw value
    // appeared in a cross-process error.
    const { handler, services } = fixture();
    vi.spyOn(services.runs, "previewFlowStep").mockResolvedValue({
      previewId: "preview-unsupported",
      columns: ["SECRET"],
      rows: [{ SECRET: Symbol("private-preview-value") } as never],
    });

    const rejection = handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT secret FROM t" },
    });

    await expect(rejection).rejects.toEqual({
      title: "Request could not be completed",
      detail: "The request could not be completed.",
      code: "PREVIEW_VALUE_UNSUPPORTED",
    });
    await expect(rejection).rejects.not.toSatisfy((error: unknown) => /secret|42/u.test(JSON.stringify(error)));
  });

  it("rejects cyclic preview values as unsupported", async () => {
    // Would fail if recursive projection overflowed or surfaced an internal error
    // instead of treating a non-JSON-safe source value as unsupported.
    const { handler, services } = fixture();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    vi.spyOn(services.runs, "previewFlowStep").mockResolvedValue({
      previewId: "preview-cycle",
      columns: ["VALUE"],
      rows: [{ VALUE: cycle } as never],
    });

    await expect(handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT value FROM t" },
    })).rejects.toEqual({
      title: "Request could not be completed",
      detail: "The request could not be completed.",
      code: "PREVIEW_VALUE_UNSUPPORTED",
    });
  });

  it("keeps rows and sensitive execution details exclusive to preview responses", async () => {
    // Would fail if the current-step execution response forwarded target binds,
    // source rows, or credential material instead of its summary.
    const { handler, services } = fixture();
    vi.spyOn(services.runs, "previewFlowStep").mockResolvedValue({
      previewId: "preview-row-boundary",
      columns: ["ID"],
      rows: [{ ID: 1 }],
    });
    vi.spyOn(services.runs, "runFlowStep").mockResolvedValue({
      affectedRows: 1,
      rows: [{ password: "private" }],
      binds: { token: "private" },
      credentialRef: "private",
      selectSql: "SELECT private",
    } as never);

    const preview = await handler("preview_flow_step", {
      request: { sourceConnectionId: "source", selectSql: "SELECT id FROM t" },
    });
    const run = await handler("run_flow_step", {
      request: {
        sourceConnectionId: "source", targetConnectionId: "target",
        selectSql: "SELECT id FROM t", upsertSql: "MERGE INTO target USING dual ON (id = :ID)",
      },
    });

    expect(preview).toEqual({ previewId: "preview-row-boundary", columns: ["ID"], rows: [{ ID: 1 }] });
    expect(run).toEqual({ affectedRows: 1 });
    expect(JSON.stringify(run)).not.toMatch(/"(?:rows|binds|password|credentialRef|selectSql)"/iu);
  });

  it("enables a disabled connection using only its ID and desired state", async () => {
    const { handler, repository } = fixture();
    repository.saveConnection({ ...connectionProfile(), enabled: false });

    await expect(handler("set_connection_enabled", {
      request: { connectionId: "production", enabled: true },
    })).resolves.toMatchObject({ id: "production", enabled: true, passwordMask: "******" });
    expect(repository.loadConnection("production")).toMatchObject({
      enabled: true,
      plaintextPassword: "s3cret",
    });
  });

  it("rejects deletion of a flow-referenced connection without changing either record", async () => {
    const { handler, repository } = fixtureWithReferencedConnection();

    await expect(handler("delete_connection", {
      request: { connectionId: "source" },
    })).rejects.toMatchObject({ code: "CONNECTION_REFERENCED" });
    expect(repository.loadConnection("source")).toBeDefined();
    expect(repository.loadFlow("daily")).toBeDefined();
  });

  it("rejects set_connection_enabled requests with unexpected extra properties", async () => {
    const { handler } = fixture();

    await expect(handler("set_connection_enabled", {
      request: { connectionId: "production", enabled: true, displayName: "forged" },
    } as never)).rejects.toEqual({
      title: "Request could not be completed",
      detail: "request payload is invalid",
      code: "INVALID_REQUEST",
    });
  });

  it("rejects delete_connection requests with unexpected extra properties", async () => {
    const { handler } = fixture();

    await expect(handler("delete_connection", {
      request: { connectionId: "production", enabled: false },
    } as never)).rejects.toEqual({
      title: "Request could not be completed",
      detail: "request payload is invalid",
      code: "INVALID_REQUEST",
    });
  });

  it("projects fixed structured errors with recovery context", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => {
          throw Object.assign(new MigrationRunnerError("RUN_FAILED", "password=hunter2"), {
            runId: "run-7",
            stepId: "step-2",
          });
        },
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });

    await expect(handler("start_run", { request: { flowId: "flow-1" } }))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "Database operation failed; inspect the database server audit log",
        code: "RUN_FAILED",
        runId: "run-7",
        stepId: "step-2",
      });
  });

  it("does not forward unknown SQL, bind, or row details", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => {
          throw new Error("SELECT secret FROM source; binds={token: raw}; rows=[private]");
        },
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });

    const rejection = handler("start_run", { request: { flowId: "flow-1" } });

    await expect(rejection).rejects.toEqual({
      title: "Request could not be completed",
      detail: "The request could not be completed.",
      code: "INTERNAL_ERROR",
    });
    await expect(rejection).rejects.not.toSatisfy((error: unknown) =>
      /select|bind|row|secret|private/iu.test(JSON.stringify(error)));
  });

  it("scrubs operational details from known and DTO-shaped errors", async () => {
    const { services } = fixture();
    const knownErrorHandler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => {
          throw new MigrationRunnerError(
            "RUN_FAILED",
            "BEGIN private_operation; source row private; END; password=hunter2",
          );
        },
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });
    const shapedErrorHandler = createDbRelayCommandHandler({
      ...services,
      flows: {
        ...services.flows,
        listFlows: async () => {
          throw {
            title: "SELECT private",
            detail: "rows=[private]",
            code: "FORGED_ERROR",
          };
        },
      },
    });

    await expect(knownErrorHandler("start_run", { request: { flowId: "flow-1" } }))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "Database operation failed; inspect the database server audit log",
        code: "RUN_FAILED",
      });
    await expect(shapedErrorHandler("list_flows")).rejects.toEqual({
      title: "Request could not be completed",
      detail: "The request could not be completed.",
      code: "INTERNAL_ERROR",
    });
  });

  it("does not forward augmented titles or unsafe codes from known errors", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => {
          throw Object.assign(
            new MigrationRunnerError("BEGIN PRIVATE_CODE", "safe-looking detail"),
            { title: "BEGIN private_operation; source row private" },
          );
        },
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });

    await expect(handler("start_run", { request: { flowId: "flow-1" } }))
      .rejects.toEqual({
        title: "Request could not be completed",
        detail: "The request could not be completed.",
        code: "INTERNAL_ERROR",
      });
  });

  it("projects run responses without nested bind, row, or SQL payloads", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => ({
          runId: "run-unsafe",
          policy: "commit_successes",
          status: { running: { step: 0, rows: [{ password: "private" }] } },
          steps: [{ succeeded: { affected_rows: 1, binds: { token: "private" } } }],
          events: [{
            type: "step_failed",
            step: 0,
            error: {
              type: "connector",
              detail: {
                code: "ORA-00001",
                message: "SELECT secret FROM source; binds={token: private}; rows=[private]",
                retryable: false,
              },
            },
          }],
        } as never),
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });

    const response = await handler("start_run", { request: { flowId: "flow-1" } });

    expect(response).toEqual({
      runId: "run-unsafe",
      policy: "commit_successes",
      status: { running: { step: 0 } },
      stepTitles: [],
      steps: [{ succeeded: { affected_rows: 1 } }],
      events: [{
        type: "step_failed",
        step: 0,
        error: {
          type: "connector",
          detail: {
            code: "ORA-00001",
            message: "Database operation failed; inspect the database server audit log",
            retryable: false,
          },
        },
      }],
    });
    expect(JSON.stringify(response)).not.toMatch(/SELECT secret|binds=|rows=\[|private|password/u);
  });

  it("projects a safe Korean bind diagnostic without a bind value", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      runs: {
        ...services.runs,
        startRun: async () => ({
          runId: "run-bind-type", policy: "all_or_nothing", status: "failed", steps: ["failed"],
          stepTitles: [],
          events: [{
            type: "step_failed", step: 0,
            error: {
              type: "connector",
              detail: {
                code: "BIND_TYPE_UNSUPPORTED",
                message: "bind-type-unsupported:CUSTOMER_ID:large_integer",
                retryable: false,
              },
            },
          }],
        }),
        recoverRun: services.runs.recoverRun.bind(services.runs),
      },
    });

    await expect(handler("start_run", { request: { flowId: "flow-1" } })).resolves.toMatchObject({
      events: [{
        error: {
          detail: {
            code: "BIND_TYPE_UNSUPPORTED",
            message: "바인드 :CUSTOMER_ID에 큰 정수 값이 있어 현재 실행할 수 없습니다.",
          },
        },
      }],
    });
  });

  it("registers one enveloped IPC endpoint with the same main allowlist", async () => {
    const { services } = fixture();
    let channel = "";
    let listener: ((event: unknown, command: unknown, request?: unknown) => Promise<DbRelayIpcResult>)
      | undefined;
    registerDbRelayIpc({
      handle: (registeredChannel, registeredListener) => {
        channel = registeredChannel;
        listener = registeredListener;
      },
    }, services, () => true);

    expect(channel).toBe("db-relay:invoke");
    await expect(listener?.({}, "list_connections"))
      .resolves.toEqual({ ok: true, value: [] });
    await expect(listener?.({}, "execute_arbitrary_sql", { sql: "select 1" }))
      .resolves.toEqual({
        ok: false,
        error: {
          title: "Request could not be completed",
          detail: "The requested command is not available.",
          code: "COMMAND_NOT_ALLOWED",
        },
      });
  });

  it("rejects IPC events from an untrusted renderer before dispatch", async () => {
    const { services } = fixture();
    let listener: ((event: unknown, command: unknown, request?: unknown) => Promise<DbRelayIpcResult>)
      | undefined;
    registerDbRelayIpc({
      handle: (_channel, registeredListener) => {
        listener = registeredListener;
      },
    }, services, () => false);

    await expect(listener?.({}, "list_connections")).resolves.toEqual({
      ok: false,
      error: {
        title: "Request could not be completed",
        detail: "The command sender is not trusted.",
        code: "IPC_SENDER_NOT_ALLOWED",
      },
    });
  });

  it("trusts only owned WebContents at the approved renderer location", () => {
    const ownedSender = {};
    const otherSender = {};
    const trusted = new Set([ownedSender]);
    const fileUrl = "file:///C:/Program%20Files/DB%20Relay/dist/index.html";

    expect(isTrustedIpcSender({
      sender: ownedSender,
      senderFrame: { url: `${fileUrl}#/flows` },
    }, trusted, fileUrl)).toBe(true);
    expect(isTrustedIpcSender({
      sender: otherSender,
      senderFrame: { url: fileUrl },
    }, trusted, fileUrl)).toBe(false);
    expect(isTrustedIpcSender({
      sender: ownedSender,
      senderFrame: { url: "https://attacker.example/" },
    }, trusted, fileUrl)).toBe(false);
    expect(isTrustedIpcSender({
      sender: ownedSender,
      senderFrame: { url: "http://localhost:1420/runs" },
    }, trusted, "http://localhost:1420/")).toBe(true);
  });

  it("rejects malformed flow and recovery DTOs before application dispatch", async () => {
    const { handler } = fixture();

    await expect(handler("save_flow", {
      request: {
        id: 42,
        name: "Invalid",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        querySteps: [],
        transactionPolicy: "all_or_nothing",
        version: 0,
      },
    } as never)).rejects.toEqual({
      title: "Request could not be completed",
      detail: "request payload is invalid",
      code: "INVALID_REQUEST",
    });
    await expect(handler("recover_run", {
      request: {
        type: "execute_arbitrary_sql",
        run_id: "run-1",
        step_id: "step-1",
      },
    } as never)).rejects.toEqual({
      title: "Request could not be completed",
      detail: "request payload is invalid",
      code: "INVALID_REQUEST",
    });
  });

  it("accepts the renderer-only query operation while projecting the preserved flow DTO", async () => {
    const { services } = fixture();
    const handler = createDbRelayCommandHandler({
      ...services,
      flows: {
        listFlows: services.flows.listFlows.bind(services.flows),
        duplicateFlow: services.flows.duplicateFlow.bind(services.flows),
        deleteFlow: services.flows.deleteFlow.bind(services.flows),
        saveFlow: async (flow) => flow,
      },
    });

    await expect(handler("save_flow", {
      request: {
        id: "flow-1",
        name: "Flow",
        sourceConnectionId: "source",
        targetConnectionId: "target",
        querySteps: [{
          id: "step-1",
          operation: "insert",
          selectSql: "SELECT id FROM source_table",
          upsertSql: "INSERT INTO target_table (id) VALUES (:id)",
        }],
        transactionPolicy: "all_or_nothing",
        version: 0,
      },
    } as never)).resolves.toEqual({
      id: "flow-1",
      name: "Flow",
      sourceConnectionId: "source",
      targetConnectionId: "target",
      querySteps: [{
        id: "step-1",
        selectSql: "SELECT id FROM source_table",
        upsertSql: "INSERT INTO target_table (id) VALUES (:id)",
      }],
      transactionPolicy: "all_or_nothing",
      version: 0,
    });
  });
});

function fixture(): {
  handler: ReturnType<typeof createDbRelayCommandHandler>;
  repository: SqliteRepository;
  services: DbRelayServices;
} {
  const repository = SqliteRepository.inMemory();
  repositories.push(repository);
  const connector: DatabaseConnectorFactory = {
    kind: "oracle",
    open: async () => {
      throw new Error("database access is not expected in IPC unit tests");
    },
  };
  const services: DbRelayServices = {
    settings: new SettingsService(repository),
    flows: new FlowService(repository),
    flowTransfer: {
      exportFlow: async () => false,
      importFlow: async () => ({ kind: "cancelled" as const }),
    },
    runs: new MigrationRunner(connector, repository, repository),
    history: new HistoryService(repository),
    connectors: new ConnectorRegistry([connector]),
  };
  return {
    handler: createDbRelayCommandHandler(services),
    repository,
    services,
  };
}

function fixtureWithReferencedConnection() {
  const result = fixture();
  result.repository.saveConnection(connectionProfile("source"));
  result.repository.saveConnection(connectionProfile("target"));
  result.repository.saveFlow(referencedFlow());
  return result;
}

function connectionProfile(id = "production"): ConnectionProfile {
  return {
    id,
    displayName: id,
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: id,
    credentialStorage: "plaintext",
    plaintextPassword: "s3cret",
    enabled: true,
    sourceReadOnly: false,
  };
}

function referencedFlow(): Flow {
  return {
    id: "daily",
    name: "Daily",
    sourceConnectionId: "source",
    targetConnectionId: "target",
    querySteps: [{
      id: "step-1",
      selectSql: "SELECT id FROM source_table",
      upsertSql: "MERGE INTO target_table USING dual ON (1 = 0) WHEN NOT MATCHED THEN INSERT (id) VALUES (:id)",
    }],
    transactionPolicy: "all_or_nothing",
    version: 0,
  };
}
