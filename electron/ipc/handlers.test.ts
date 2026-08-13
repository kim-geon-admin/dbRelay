import { afterEach, describe, expect, it } from "vitest";

import { HistoryService } from "../application/historyService";
import { MigrationRunner, MigrationRunnerError } from "../application/migrationRunner";
import { FlowService } from "../application/flowService";
import { SettingsService } from "../application/settingsService";
import { ConnectorRegistry } from "../connectors/registry";
import type { DatabaseConnectorFactory } from "../connectors/databaseConnector";
import type { ConnectionProfile, Flow } from "../domain/models";
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
