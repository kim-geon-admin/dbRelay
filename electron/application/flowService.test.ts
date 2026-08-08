import { describe, expect, it } from "vitest";

import { FlowService, type FlowRepository } from "./flowService";
import type { ConnectionProfile, Flow } from "../domain/models";

describe("FlowService", () => {
  it("requires distinct source and target connections", async () => {
    const repository = new MemoryFlowRepository();
    const service = new FlowService(repository);

    await expect(service.saveFlow({ ...flow(), targetConnectionId: "source" }))
      .rejects.toMatchObject({ code: "CONNECTIONS_NOT_DISTINCT" });
  });

  it("validates required query steps and their SQL policies", async () => {
    const repository = new MemoryFlowRepository();
    const service = new FlowService(repository);

    await expect(service.saveFlow({ ...flow(), querySteps: [] }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "at least one query step is required" });
    await expect(service.saveFlow({
      ...flow(),
      querySteps: [{ id: "step", selectSql: "DELETE FROM source_table", upsertSql: "UPDATE target_table SET id = :id" }],
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("returns the repository-incremented flow version", async () => {
    const repository = new MemoryFlowRepository();
    const service = new FlowService(repository);

    await expect(service.saveFlow(flow())).resolves.toMatchObject({ version: 1 });
  });

  it("duplicates a flow under a new ID and rejects an existing ID", async () => {
    const repository = new MemoryFlowRepository();
    const service = new FlowService(repository);
    await service.saveFlow(flow());

    await expect(service.duplicateFlow("daily", "daily-copy")).resolves.toMatchObject({
      id: "daily-copy",
      name: "Daily copy",
      version: 1,
    });
    await expect(service.duplicateFlow("daily", "daily-copy"))
      .rejects.toMatchObject({ code: "FLOW_ALREADY_EXISTS" });
  });
});

class MemoryFlowRepository implements FlowRepository {
  private readonly flows = new Map<string, Flow>();
  private readonly connections = new Map<string, ConnectionProfile>([
    ["source", connection("source")],
    ["target", connection("target")],
  ]);

  loadFlow(id: string): Flow | undefined {
    const saved = this.flows.get(id);
    return saved === undefined ? undefined : structuredClone(saved);
  }

  saveFlow(candidate: Flow): void {
    const current = this.flows.get(candidate.id);
    this.flows.set(candidate.id, structuredClone({
      ...candidate,
      version: current === undefined ? 1 : current.version + 1,
    }));
  }

  listFlows(): Flow[] {
    return [...this.flows.values()].map((saved) => structuredClone(saved));
  }

  loadConnection(id: string): ConnectionProfile | undefined {
    return this.connections.get(id);
  }

  loadRunnableConnection(id: string): ConnectionProfile | undefined {
    const saved = this.loadConnection(id);
    return saved?.enabled === false ? undefined : saved;
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
      id: "step",
      selectSql: "SELECT id FROM source_table",
      upsertSql: "UPDATE target_table SET id = :id",
    }],
    transactionPolicy: "commit_successes",
    version: 0,
  };
}
