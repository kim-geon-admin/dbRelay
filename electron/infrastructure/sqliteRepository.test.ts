import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteRepository } from "./sqliteRepository";
import type { ConnectionProfile, Flow } from "../domain/models";
import { RunError, RunState } from "../domain/runState";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("SqliteRepository migrations", () => {
  it("migrates legacy connection data without losing a keyring profile", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE connection_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        service_name TEXT NOT NULL,
        username TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      INSERT INTO connection_profiles VALUES
        ('legacy', 'Legacy', 'oracle', 'legacy.example.test', 1521, 'XE', 'relay', 'legacy-ref', 1);
    `);

    const repository = new SqliteRepository(database);

    expect(repository.loadConnection("legacy")?.credentialStorage).toBe("keyring");
  });
});

describe("SqliteRepository connections and flows", () => {
  it("round-trips plaintext connections in display-name order", () => {
    const repository = openRepository();
    repository.saveConnection(profile("z", "Zulu"));
    repository.saveConnection(profile("a", "Alpha"));

    expect(repository.listConnections().map((connection) => connection.id)).toEqual(["a", "z"]);
    expect(repository.loadConnection("a")).toMatchObject({
      credentialStorage: "plaintext",
      plaintextPassword: "secret-a",
      sid: "XE",
      sourceReadOnly: true,
    });
  });

  it("increments flow versions and preserves query-step order", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));
    const initial = flow("daily", 0);

    repository.saveFlow(initial);
    const saved = repository.loadFlow("daily");
    expect(saved).toMatchObject({ version: 1 });
    expect(saved?.querySteps.map((step) => step.id)).toEqual(["first", "second"]);
    expect(saved?.querySteps.map((step) => step.title)).toEqual(["Step 1", "Step 2"]);

    repository.saveFlow({ ...saved!, name: "Daily updated" });
    expect(repository.loadFlow("daily")).toMatchObject({ name: "Daily updated", version: 2 });
  });

  it("rejects stale flow versions without overwriting the current flow", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));
    repository.saveFlow(flow("daily", 0));

    expect(() => repository.saveFlow({ ...flow("daily", 0), name: "Stale" }))
      .toThrowError(expect.objectContaining({ code: "FLOW_VERSION_CONFLICT" }));
    expect(repository.loadFlow("daily")?.name).toBe("Daily");
  });

  it("orders flows by name then ID", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));
    repository.saveFlow({ ...flow("z-flow", 0), name: "Zulu" });
    repository.saveFlow({ ...flow("a-flow", 0), name: "Alpha" });

    expect(repository.listFlows().map((saved) => saved.id)).toEqual(["a-flow", "z-flow"]);
  });

  it("blocks disabled connections and deletion of referenced connections", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));
    repository.saveFlow(flow("daily", 0));

    repository.disableConnection("source");

    expect(() => repository.loadRunnableConnection("source"))
      .toThrowError(expect.objectContaining({ code: "CONNECTION_DISABLED" }));
    expect(() => repository.deleteConnection("source"))
      .toThrowError(expect.objectContaining({ code: "CONNECTION_REFERENCED" }));
  });
});

describe("SqliteRepository run history", () => {
  it("orders history by execution start time descending", () => {
    const repository = openRepository();
    repository.createRun("older", RunState.running("all_or_nothing", 1));
    repository.createRun("newer", RunState.running("all_or_nothing", 1));
    const database = (repository as unknown as { database: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).database;
    database.prepare("UPDATE runs SET started_at_ms = ? WHERE id = ?").run(100, "older");
    database.prepare("UPDATE runs SET started_at_ms = ? WHERE id = ?").run(200, "newer");
    expect(repository.listRuns().map((run) => run.runId)).toEqual(["newer", "older"]);
  });

  it("round-trips a saved query-step title", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));

    repository.saveFlow({
      ...flow("daily", 0),
      querySteps: [{
        id: "customers",
        title: "Load customers",
        selectSql: "SELECT id FROM customers",
        upsertSql: "MERGE ordered_first",
      }],
    });

    expect(repository.loadFlow("daily")?.querySteps).toMatchObject([{ title: "Load customers" }]);
  });

  it("recovers the flow name from the saved flow when legacy history lacks it", () => {
    const repository = openRepository();
    repository.saveConnection(profile("source", "Source"));
    repository.saveConnection(profile("target", "Target"));
    repository.saveFlow(flow("daily", 0));
    repository.createRunForFlow("legacy-flow-name", RunState.running("all_or_nothing", 1), repository.loadFlow("daily")!);
    const database = (repository as unknown as { database: { prepare: (sql: string) => { get: (...args: unknown[]) => { state_json: string }; run: (...args: unknown[]) => void } } }).database;
    const stored = database.prepare("SELECT state_json FROM runs WHERE id = ?").get("legacy-flow-name");
    const state = JSON.parse(stored.state_json) as Record<string, unknown>;
    delete state.flow_name;
    database.prepare("UPDATE runs SET state_json = ? WHERE id = ?").run(JSON.stringify(state), "legacy-flow-name");
    expect(repository.listRuns()[0].flowName).toBe("Daily");
  });

  it("stores only safe binding metadata and sanitized connector details", () => {
    const repository = openRepository();
    const source = profile("source", "Source");
    const target = profile("target", "Target");
    repository.saveConnection(source);
    repository.saveConnection(target);
    repository.saveFlow(flow("daily", 0));
    const savedFlow = repository.loadFlow("daily")!;
    const state = RunState.running("commit_successes", 2);
    state.recordStepFailure(0, RunError.connectorWithRetryable(
      "ORA-00001",
      "password=history-secret",
      true,
    ));

    repository.createBoundRun("run-1", state, {
      flow: savedFlow,
      sourceProfile: source,
      targetProfile: target,
    });

    const serialized = repository.historyJsonForTest("run-1")!;
    expect(serialized).not.toContain("history-secret");
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("SELECT ordered_first");
    expect(serialized).not.toContain("MERGE ordered_second");
    expect(repository.listRuns()[0]).toMatchObject({
      runId: "run-1",
      flowId: "daily",
      flowVersion: 1,
    });
    const event = repository.listRuns()[0].state.events()[0];
    expect(event).toMatchObject({
      type: "step_failed",
      error: { detail: { code: "ORA-00001", retryable: true } },
    });
  });

  it("rejects a colliding initial run ID without replacing history", () => {
    const repository = openRepository();
    repository.createRun("same-run", RunState.running("all_or_nothing", 1));

    expect(() => repository.createRun("same-run", RunState.running("commit_successes", 2)))
      .toThrowError(expect.objectContaining({ code: "RUN_ID_COLLISION" }));
    expect(repository.loadRun("same-run")?.policy()).toBe("all_or_nothing");
  });

  it("does not persist neutral-looking password, bind, or source-row values", () => {
    const repository = openRepository();
    const state = RunState.running("commit_successes", 1);
    state.recordStepFailure(
      0,
      RunError.connector("ORA-20000", "hunter2 customer-123 804f3c2a"),
    );

    repository.createRun("neutral-values", state);

    const serialized = repository.historyJsonForTest("neutral-values")!;
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("customer-123");
    expect(serialized).not.toContain("804f3c2a");
  });

  it("persists a safe Korean bind diagnostic without a bind value", () => {
    const repository = openRepository();
    const state = RunState.running("commit_successes", 1);
    state.recordStepFailure(0, RunError.connector(
      "BIND_TYPE_UNSUPPORTED",
      "bind-type-unsupported:CUSTOMER_ID:large_integer",
    ));

    repository.createRun("safe-bind-diagnostic", state);

    const event = repository.listRuns()[0].state.events()[0];
    expect(event).toMatchObject({
      error: {
        detail: {
          code: "BIND_TYPE_UNSUPPORTED",
          message: "바인드 :CUSTOMER_ID에 큰 정수 값이 있어 현재 실행할 수 없습니다.",
        },
      },
    });
    expect(repository.historyJsonForTest("safe-bind-diagnostic")).not.toContain("9007199254740993");
  });
});

function openRepository(): SqliteRepository {
  const database = new Database(":memory:");
  databases.push(database);
  return new SqliteRepository(database);
}

function profile(id: string, displayName: string): ConnectionProfile {
  return {
    id,
    displayName,
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: id,
    credentialStorage: "plaintext",
    plaintextPassword: `secret-${id}`,
    enabled: true,
    sourceReadOnly: true,
  };
}

function flow(id: string, version: number): Flow {
  return {
    id,
    name: id === "daily" ? "Daily" : id,
    sourceConnectionId: "source",
    targetConnectionId: "target",
    querySteps: [
      { id: "first", selectSql: "SELECT ordered_first FROM source_table", upsertSql: "MERGE INTO target_table USING dual ON (1 = 0) WHEN NOT MATCHED THEN INSERT (id) VALUES (:id)" },
      { id: "second", selectSql: "SELECT ordered_second FROM source_table", upsertSql: "UPDATE target_table SET value = :value" },
    ],
    transactionPolicy: "commit_successes",
    version,
  };
}
