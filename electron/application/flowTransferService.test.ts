import { describe, expect, it } from "vitest";

import { FlowTransferService } from "./flowTransferService";
import type { ConnectionProfile, Flow } from "../domain/models";
import type { FlowRepository } from "./ports";

describe("FlowTransferService", () => {
  it("imports a flow under a new ID when both referenced connections exist", async () => {
    const repository = new MemoryFlowRepository();
    const transfer = new FlowTransferService(repository, {
      save: async () => true,
      open: async () => ({
        format: "db-relay-flow",
        formatVersion: 1,
        flow: flow(),
      }),
    }, () => "imported-flow");

    await expect(transfer.importFlow()).resolves.toEqual({
      kind: "ready",
      flow: {
        ...flow(),
        id: "imported-flow",
        version: 0,
      },
    });
  });

  it("requires a connection selection without changing the available connection", async () => {
    const repository = new MemoryFlowRepository();
    const transfer = new FlowTransferService(repository, {
      save: async () => true,
      open: async () => ({
        format: "db-relay-flow",
        formatVersion: 1,
        flow: { ...flow(), targetConnectionId: "missing-target" },
      }),
    }, () => "imported-flow");

    await expect(transfer.importFlow()).resolves.toEqual({
      kind: "needs_connection_selection",
      flow: {
        ...flow(),
        id: "imported-flow",
        targetConnectionId: "",
        version: 0,
      },
    });
  });

  it("exports only the selected flow configuration", async () => {
    const saved: unknown[] = [];
    const repository = new MemoryFlowRepository(flow());
    const transfer = new FlowTransferService(repository, {
      save: async (file) => { saved.push(file); return true; },
      open: async () => undefined,
    }, () => "unused");

    await expect(transfer.exportFlow("daily")).resolves.toBe(true);
    expect(saved).toEqual([{
      format: "db-relay-flow",
      formatVersion: 1,
      flow: flow(),
    }]);
  });

  it("imports legacy steps that do not yet contain a title", async () => {
    const repository = new MemoryFlowRepository();
    const transfer = new FlowTransferService(repository, {
      save: async () => true,
      open: async () => ({ format: "db-relay-flow", formatVersion: 1, flow: flow() }),
    }, () => "imported-flow");

    await expect(transfer.importFlow()).resolves.toMatchObject({
      kind: "ready",
      flow: { querySteps: [{ id: "step-1" }] },
    });
  });
});

class MemoryFlowRepository implements FlowRepository {
  constructor(private readonly saved?: Flow) {}

  loadFlow(id: string): Flow | undefined {
    return id === this.saved?.id ? structuredClone(this.saved) : undefined;
  }
  saveFlow(): void {}
  deleteFlow(): void {}
  listFlows(): Flow[] { return []; }
  loadRunnableConnection(): ConnectionProfile | undefined { return undefined; }
  loadConnection(id: string): ConnectionProfile | undefined {
    return id === "source" || id === "target" ? connection(id) : undefined;
  }
}

function connection(id: string): ConnectionProfile {
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
    plaintextPassword: "secret",
    enabled: true,
    sourceReadOnly: id === "source",
  };
}

function flow(): Flow {
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
    version: 7,
  };
}
