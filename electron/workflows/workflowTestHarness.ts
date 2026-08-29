import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlowService } from "../application/flowService";
import { EditablePreviewCache } from "../application/editablePreviewCache";
import { HistoryService } from "../application/historyService";
import { MigrationRunner } from "../application/migrationRunner";
import { SettingsService } from "../application/settingsService";
import { OracleConnector } from "../connectors/oracleConnector";
import { ConnectorRegistry } from "../connectors/registry";
import { SqliteRepository } from "../infrastructure/sqliteRepository";
import {
  createDbRelayCommandHandler,
  type DbRelayCommandHandler,
} from "../ipc/handlers";

export type WorkflowTables = {
  readonly customerSource: string;
  readonly orderSource: string;
  readonly auditSource: string;
  readonly customerTarget: string;
  readonly orderTarget: string;
  readonly auditTarget: string;
};

export type WorkflowHarness = {
  readonly handler: DbRelayCommandHandler;
  readonly passwordLength: number;
  readonly secretSentinel: string;
  readonly tables: WorkflowTables;
  saveConnections(): Promise<{ sourceId: string; targetId: string }>;
  createFixture(): Promise<void>;
  close(): Promise<void>;
};

type OracleEndpoint = {
  readonly host: string;
  readonly port: number;
  readonly sid: string;
  readonly username: string;
  readonly password: string;
};

const sourceId = "workflow-source";
const targetId = "workflow-target";

export async function createWorkflowHarness(url: string): Promise<WorkflowHarness> {
  const endpoint = parseOracleTestUrl(url);
  const directory = await mkdtemp(join(tmpdir(), "db-relay-workflow-"));
  const repository = SqliteRepository.open(join(directory, "workflow.sqlite"));
  const connector = new OracleConnector();
  const handler = createDbRelayCommandHandler({
    settings: new SettingsService(repository),
    flows: new FlowService(repository),
    flowTransfer: {
      exportFlow: async () => false,
      importFlow: async () => ({ kind: "cancelled" as const }),
    },
    runs: new MigrationRunner(connector, repository, repository, undefined, new EditablePreviewCache()),
    history: new HistoryService(repository),
    connectors: new ConnectorRegistry([connector]),
  });
  const tables = workflowTables();
  let repositoryClosed = false;

  return {
    handler,
    passwordLength: Array.from(endpoint.password).length,
    secretSentinel: endpoint.password,
    tables,
    async saveConnections() {
      await handler("save_connection", {
        request: connectionRequest(sourceId, "Workflow source", endpoint),
      });
      await handler("save_connection", {
        request: connectionRequest(targetId, "Workflow target", endpoint),
      });
      return { sourceId, targetId };
    },
    async createFixture() {
      // Task 2 adds DDL and seed data behind this fixture-only boundary.
    },
    async close() {
      if (!repositoryClosed) {
        repository.close();
        repositoryClosed = true;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function connectionRequest(id: string, displayName: string, endpoint: OracleEndpoint) {
  return {
    id,
    displayName,
    kind: "oracle" as const,
    host: endpoint.host,
    port: endpoint.port,
    sid: endpoint.sid,
    username: endpoint.username,
    secret: endpoint.password,
  };
}

function parseOracleTestUrl(value: string): OracleEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DB_RELAY_ORACLE_TEST_URL must use a valid oracle:// URL");
  }
  if (parsed.protocol !== "oracle:") {
    throw new Error("DB_RELAY_ORACLE_TEST_URL must use oracle://");
  }

  const sid = decode(parsed.pathname.replace(/^\//u, ""));
  const username = decode(parsed.username);
  const password = decode(parsed.password);
  const port = parsed.port === "" ? 1521 : Number(parsed.port);
  if (parsed.hostname === "" || sid === "" || username === ""
    || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DB_RELAY_ORACLE_TEST_URL must include user, host, port, and SID");
  }

  return {
    host: parsed.hostname,
    port,
    sid,
    username,
    password,
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("DB_RELAY_ORACLE_TEST_URL contains invalid URL encoding");
  }
}

function workflowTables(): WorkflowTables {
  const prefix = `DBR_WF_${String(process.pid).slice(-4)}_${randomUUID().replace(/-/gu, "").slice(0, 4)}`;
  return {
    customerSource: `${prefix}_SRC_CUSTOMER`,
    orderSource: `${prefix}_SRC_ORDER`,
    auditSource: `${prefix}_SRC_AUDIT`,
    customerTarget: `${prefix}_TGT_CUSTOMER`,
    orderTarget: `${prefix}_TGT_ORDER`,
    auditTarget: `${prefix}_TGT_AUDIT`,
  };
}
