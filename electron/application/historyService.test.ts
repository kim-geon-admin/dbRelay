import { afterEach, describe, expect, it } from "vitest";

import type { ConnectionProfile, Flow } from "../domain/models";
import { RunError, RunState } from "../domain/runState";
import { SqliteRepository } from "../infrastructure/sqliteRepository";
import { HistoryService } from "./historyService";

describe("HistoryService", () => {
  const repositories: SqliteRepository[] = [];

  afterEach(() => {
    repositories.splice(0).forEach((repository) => repository.close());
  });

  it("projects safe run history without execution inputs or credentials", async () => {
    // Would fail if a repository binding or internal RunState wrapper were
    // returned directly instead of an explicit history DTO.
    const repository = SqliteRepository.inMemory();
    repositories.push(repository);
    const source = connection("source", "password-source-value");
    const target = connection("target", "password-target-value");
    const flow = sensitiveFlow();
    repository.saveConnection(source);
    repository.saveConnection(target);
    repository.saveFlow(flow);
    const savedFlow = repository.loadFlow(flow.id)!;
    const state = RunState.running("commit_successes", 1);
    state.recordStepFailure(
      0,
      RunError.connector(
        "ORA-00001",
        "password=password-error-value source-row-value bind-value",
      ),
    );
    repository.createBoundRun("run-safe", state, {
      flow: savedFlow,
      sourceProfile: source,
      targetProfile: target,
    });

    const runs = await new HistoryService(repository).listRunHistory();

    expect(runs).toEqual([expect.objectContaining({
      runId: "run-safe",
      flowId: "sensitive-flow",
      flowVersion: 1,
      startedAt: expect.any(Number),
      endedAt: null,
      policy: "commit_successes",
      status: { awaiting_recovery: { failed_step: 0 } },
      steps: ["failed"],
    })]);
    expect(Object.keys(runs[0]).sort()).toEqual([
      "endedAt",
      "events",
      "flowId",
      "flowVersion",
      "policy",
      "runId",
      "startedAt",
      "status",
      "steps",
    ]);
    expect(JSON.stringify(runs)).not.toMatch(
      /password-source-value|password-target-value|password-error-value|SELECT secret_sql|MERGE secret_sql|source-row-value|bind-value|credential:\/\/sensitive/,
    );
  });

  it("defaults absent legacy flow metadata and normalizes missing end time to null", async () => {
    const repository = SqliteRepository.inMemory();
    repositories.push(repository);
    repository.createRun("legacy-run", RunState.running("all_or_nothing", 1));

    const runs = await new HistoryService(repository).listRunHistory();

    expect(runs[0]).toMatchObject({
      flowId: "",
      flowVersion: 0,
      endedAt: null,
    });
  });
});

function connection(id: "source" | "target", password: string): ConnectionProfile {
  return {
    id,
    displayName: id,
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: `credential://sensitive-${id}`,
    credentialStorage: "plaintext",
    plaintextPassword: password,
    enabled: true,
    sourceReadOnly: id === "source",
  };
}

function sensitiveFlow(): Flow {
  return {
    id: "sensitive-flow",
    name: "Sensitive flow",
    sourceConnectionId: "source",
    targetConnectionId: "target",
    querySteps: [{
      id: "step",
      selectSql: "SELECT secret_sql, source-row-value FROM sensitive_source",
      upsertSql: "MERGE secret_sql USING :bind-value",
    }],
    transactionPolicy: "commit_successes",
    version: 0,
  };
}
