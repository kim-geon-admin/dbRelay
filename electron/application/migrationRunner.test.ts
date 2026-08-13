import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectorError,
  type DatabaseConnectorFactory,
  type DatabaseSession,
} from "../connectors/databaseConnector";
import type {
  ConnectionProfile,
  DomainValue,
  Flow,
  NamedRow,
  RowSet,
  TransactionPolicy,
} from "../domain/models";
import { SqliteRepository } from "../infrastructure/sqliteRepository";
import {
  MigrationRunner,
  type CredentialResolver,
  type RecoveryRequest,
} from "./migrationRunner";

describe("MigrationRunner", () => {
  const harnesses: RunnerHarness[] = [];

  afterEach(() => {
    harnesses.splice(0).forEach((harness) => harness.close());
  });

  function harness(policy: TransactionPolicy): RunnerHarness {
    const value = new RunnerHarness(policy);
    harnesses.push(value);
    return value;
  }

  it("returns all source preview rows without creating history", async () => {
    // Would fail if preview persisted a run, opened a target session, or projected only part of the row set.
    const test = harness("all_or_nothing").sourceRowsAt(0, {
      columns: ["ID"],
      unsupportedBindColumns: [],
      rows: [{ ID: 1 }, { ID: 2 }],
    });

    const result = await test.runner.previewFlowStep({
      sourceConnectionId: "source",
      selectSql: "SELECT id FROM customers",
    });

    expect(result).toEqual({ columns: ["ID"], rows: [{ ID: 1 }, { ID: 2 }] });
    expect(test.repository.listRuns()).toEqual([]);
    expect(test.connector.targetOperations).toEqual([]);
    expect(test.connector.closedProfiles).toEqual(["source"]);
  });

  it("rejects invalid preview Source SQL", async () => {
    // Would fail if preview accepted a non-read statement before opening the source session.
    const test = harness("all_or_nothing");

    await expect(test.runner.previewFlowStep({
      sourceConnectionId: "source",
      selectSql: "DELETE FROM customers",
    })).rejects.toMatchObject({ code: "STATEMENT_INVALID" });

    expect(test.connector.openedProfiles).toEqual([]);
  });

  it("commits the unsaved current step without creating a run", async () => {
    // Would fail if immediate execution persisted history or did not use exactly one target transaction.
    const test = harness("all_or_nothing");

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    })).resolves.toEqual({ affectedRows: 1 });

    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "commit"]);
    expect(test.repository.listRuns()).toEqual([]);
    expect(test.connector.closedProfiles).toEqual(["target", "source"]);
  });

  it("rolls back the current step and retains the Oracle code", async () => {
    // Would fail if post-begin failures skipped rollback or converted the native error code.
    const test = harness("all_or_nothing").targetFailsAt(
      0,
      new ConnectorError("ORA-00001", "private"),
    );

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    })).rejects.toMatchObject({ code: "ORA-00001" });

    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "rollback"]);
    expect(test.repository.listRuns()).toEqual([]);
  });

  it.each([
    {
      label: "Source SQL",
      selectSql: "DELETE FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    },
    {
      label: "Target SQL",
      selectSql: "SELECT id FROM customer",
      upsertSql: "SELECT id FROM customer",
    },
  ])("rejects invalid $label before opening database sessions", async ({ selectSql, upsertSql }) => {
    const test = harness("all_or_nothing");

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql,
      upsertSql,
    })).rejects.toMatchObject({ code: "STATEMENT_INVALID" });

    expect(test.connector.openedProfiles).toEqual([]);
    expect(test.connector.sourceQueries).toEqual([]);
    expect(test.connector.targetTransactions()).toEqual([]);
  });

  it("rolls back the target when the second all-or-nothing step fails", async () => {
    // Would fail if the runner committed partial work, opened the transaction
    // before all preflight mapping, or leaked either connector session.
    const test = harness("all_or_nothing").targetFailsAt(1);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("rolled_back");
    expect(test.connector.targetTransactions()).toEqual([
      "begin",
      "execute:0",
      "execute:1",
      "rollback",
    ]);
    expect(test.connector.sourceQueries).toEqual(["customer", "address"]);
    expect(test.repository.loadRun(result.runId)?.status()).toBe("rolled_back");
    expect(test.connector.closedProfiles).toEqual(["target", "source"]);
  });

  it("persists an indeterminate run when all-or-nothing rollback fails", async () => {
    const test = harness("all_or_nothing")
      .targetFailsAt(1)
      .rollbackFails(new ConnectorError("ORA-03113", "rollback connection lost"));

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toEqual({ in_doubt: expect.objectContaining({ step: 1 }) });
    await expect(test.runner.recoverRun({
      type: "skip_and_continue",
      runId: result.runId,
      stepId: "address",
    })).rejects.toMatchObject({ code: "RECOVERY_NOT_AVAILABLE" });
  });

  it.each([
    {
      name: "a missing bind column",
      configure: (test: RunnerHarness) => test.sourceRowsAt(0, rowSet("UNRELATED", 1)),
      expectedClosed: ["target", "source"],
    },
    {
      name: "zero rows without the required alias",
      configure: (test: RunnerHarness) => test.sourceRowsAt(0, emptyRowSet()),
      expectedClosed: ["target", "source"],
    },
    {
      name: "a numeric target bind",
      configure: (test: RunnerHarness) => test.stepSql(
        0,
        "SELECT id FROM customer",
        "MERGE INTO customer USING dual ON (id = :1)",
      ),
      expectedClosed: [],
    },
    {
      name: "unsupported timezone metadata on a bound column",
      configure: (test: RunnerHarness) => test.sourceRowsAt(0, {
        columns: ["ID"],
        unsupportedBindColumns: ["ID"],
        rows: [],
      }),
      expectedClosed: ["target", "source"],
    },
    {
      name: "an ambiguous timestamp bind",
      configure: (test: RunnerHarness) => test.sourceRowsAt(0, rowSet("ID", new Date(0))),
      expectedClosed: ["target", "source"],
    },
    {
      name: "a timezone timestamp bind",
      configure: (test: RunnerHarness) => test.sourceRowsAt(0, rowSet("ID", {
        year: 2026,
        month: 8,
        day: 8,
        hour: 1,
        minute: 2,
        second: 3,
        microsecond: 0,
        tzHourOffset: 9,
        tzMinuteOffset: 0,
      })),
      expectedClosed: ["target", "source"],
    },
  ])("blocks $name before target begin", async ({ configure, expectedClosed }) => {
    const test = configure(harness("all_or_nothing"));

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("failed");
    expect(test.connector.targetTransactions()).toEqual([]);
    expect(test.connector.closedProfiles).toEqual(expectedClosed);
  });

  it("allows unsupported metadata on an unbound source column", async () => {
    const test = harness("all_or_nothing").sourceRowsAt(0, {
      columns: ["ID", "AUDIT_TSTZ"],
      unsupportedBindColumns: ["AUDIT_TSTZ"],
      rows: [{ ID: 1, AUDIT_TSTZ: "not bound" }],
    });

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.targetTransactions()).toEqual([
      "begin",
      "execute:0",
      "execute:1",
      "commit",
    ]);
  });

  it("never returns or persists target bind values from an execution error", async () => {
    const bindValue = "batch-value-that-must-not-leak";
    const test = harness("all_or_nothing")
      .sourceRowsAt(0, rowSet("ID", bindValue))
      .targetFailsAt(0, new ConnectorError("ORA-00001", `driver rejected ${bindValue}`));

    const result = await test.runner.startRun(test.flowId);

    expect(JSON.stringify(result)).not.toContain(bindValue);
    expect(test.repository.historyJsonForTest(result.runId)).not.toContain(bindValue);
  });

  it("never returns or persists source values from a query error", async () => {
    const sourceValue = "source-value-that-must-not-leak";
    const test = harness("all_or_nothing").sourceFailsAt(
      0,
      new ConnectorError("ORA-20001", `source function failed for ${sourceValue}`),
    );

    const result = await test.runner.startRun(test.flowId);

    expect(JSON.stringify(result)).not.toContain(sourceValue);
    expect(test.repository.historyJsonForTest(result.runId)).not.toContain(sourceValue);
  });

  it("rejects identical source and target connections before connector work", async () => {
    const test = harness("all_or_nothing");
    const changed = test.repository.loadFlow(test.flowId)!;
    changed.targetConnectionId = changed.sourceConnectionId;
    test.repository.database.prepare(
      "UPDATE flows SET target_connection_id = source_connection_id WHERE id = ?",
    ).run(test.flowId);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("failed");
    expect(test.connector.openedProfiles).toEqual([]);
  });

  it("allows a source profile without the legacy read-only flag", async () => {
    const test = harness("all_or_nothing");
    const source = test.repository.loadConnection("source")!;
    test.repository.saveConnection({ ...source, sourceReadOnly: false });

    await expect(test.runner.startRun(test.flowId)).resolves.toMatchObject({ status: "completed" });
  });

  it("commits a successful all-or-nothing run once and reuses preflight batches", async () => {
    const test = harness("all_or_nothing");

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.targetTransactions()).toEqual([
      "begin",
      "execute:0",
      "execute:1",
      "commit",
    ]);
    expect(test.connector.sourceQueries).toEqual(["customer", "address"]);
  });

  it("uses distinct opaque run IDs for repeated starts", async () => {
    const test = harness("all_or_nothing");

    const first = await test.runner.startRun(test.flowId);
    const second = await test.runner.startRun(test.flowId);

    expect(first.runId).not.toBe(second.runId);
    expect(first.runId).not.toMatch(/^two-step-flow-/);
    expect(second.runId).not.toMatch(/^two-step-flow-/);
  });

  it("closes an opened source session when opening the target fails", async () => {
    const test = harness("all_or_nothing").openFailsFor("target");

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("failed");
    expect(test.connector.closedProfiles).toEqual(["source"]);
  });

  it("attempts to close both sessions when the first close throws synchronously", async () => {
    // Would fail if cleanup called close methods eagerly while constructing
    // Promise.allSettled inputs, allowing the first throw to skip the second.
    const test = harness("all_or_nothing").closeSynchronouslyFailsFor("target");

    await expect(test.runner.startRun(test.flowId)).resolves.toMatchObject({ status: "completed" });

    expect(test.connector.closedProfiles).toEqual(["target", "source"]);
  });

  it("preserves committed steps and awaits recovery after a later failure", async () => {
    const test = harness("commit_successes").targetFailsAt(1);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(result.steps[0]).toEqual({ succeeded: { affected_rows: 1 } });
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0",
      "execute:0",
      "commit:0",
      "begin:1",
      "execute:1",
      "rollback:1",
    ]);
    expect(test.connector.closedProfiles).toEqual(["target", "source"]);
  });

  it("skip records the decision and completes remaining steps", async () => {
    const test = harness("commit_successes").targetFailsAt(0);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({
      type: "skip_and_continue",
      runId: paused.runId,
      stepId: "customer",
    });

    expect(result.status).toBe("completed");
    expect(result.steps[0]).toBe("skipped_by_user");
    expect(result.steps[1]).toEqual({ succeeded: { affected_rows: 1 } });
    expect(test.repository.loadRun(paused.runId)?.status()).toBe("completed");
  });

  it("edit-and-retry versions the flow and executes the failed step", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequest(paused.runId, {
      selectSql: "SELECT address_id FROM revised_address",
      upsertSql: "MERGE INTO revised_address USING dual ON (address_id = :ADDRESS_ID)",
    }));

    expect(result.status).toBe("completed");
    expect(result.steps[1]).toEqual({ succeeded: { affected_rows: 1 } });
    expect(test.repository.loadFlow(test.flowId)).toMatchObject({
      version: 2,
      querySteps: expect.arrayContaining([
        expect.objectContaining({ selectSql: "SELECT address_id FROM revised_address" }),
      ]),
    });
    expect(test.connector.executedSql[test.connector.executedSql.length - 1])
      .toContain("revised_address");
  });

  it("invalid recovery edits do not overwrite the saved flow", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);
    const saved = test.repository.loadFlow(test.flowId);

    const result = await test.runner.recoverRun(editRequest(paused.runId, {
      selectSql: "DELETE FROM address",
    }));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(test.repository.loadFlow(test.flowId)).toEqual(saved);
  });

  it("a failed edit retry returns to awaiting recovery", async () => {
    const test = harness("commit_successes").targetFailsAt(1).targetFailsAt(2);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequest(paused.runId));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(result.steps[0]).toEqual({ succeeded: { affected_rows: 1 } });
    expect(result.steps[1]).toBe("failed");
  });

  it("recovery rechecks changed zero-row metadata before target begin", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);
    const before = test.connector.targetTransactions();
    test.sourceRowsForQuery(2, emptyRowSet());

    const result = await test.runner.recoverRun(editRequest(paused.runId));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(test.connector.targetTransactions()).toEqual(before);
  });

  it("recovery validates the fresh execution batch before target begin", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);
    const before = test.connector.targetTransactions();
    test.sourceRowsForQuery(3, rowSet("ADDRESS_ID", new Date(0)));

    const result = await test.runner.recoverRun(editRequest(paused.runId));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(test.connector.targetTransactions()).toEqual(before);
  });

  it("rejects recovery requests for a nonfailed step", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    await expect(test.runner.recoverRun({
      type: "skip_and_continue",
      runId: paused.runId,
      stepId: "customer",
    })).rejects.toMatchObject({ code: "RECOVERY_STEP_MISMATCH" });
  });

  it("rejects recovery when the flow changes after the run paused", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);
    const before = test.connector.targetTransactions();
    const changed = test.repository.loadFlow(test.flowId)!;
    changed.querySteps[0].upsertSql = "MERGE INTO changed USING dual ON (id = :ID)";
    test.repository.saveFlow(changed);

    await expect(test.runner.recoverRun({
      type: "skip_and_continue",
      runId: paused.runId,
      stepId: "address",
    })).rejects.toMatchObject({ code: "RECOVERY_CONFIG_MISMATCH" });
    expect(test.connector.targetTransactions()).toEqual(before);
  });

  it("rejects recovery when only a bound profile changes", async () => {
    const test = harness("commit_successes").targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);
    const target = test.repository.loadConnection("target")!;
    test.repository.saveConnection({ ...target, host: "changed.example.test" });

    await expect(test.runner.recoverRun({
      type: "skip_and_continue",
      runId: paused.runId,
      stepId: "address",
    })).rejects.toMatchObject({ code: "RECOVERY_CONFIG_MISMATCH" });
  });

  it("stop preserves committed steps and does not execute later steps", async () => {
    const test = harness("commit_successes").targetFailsAt(0);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({
      type: "stop",
      runId: paused.runId,
      stepId: "customer",
    });

    expect(result.status).toBe("stopped_by_user");
    expect(result.steps[1]).toBe("not_run");
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0",
      "execute:0",
      "rollback:0",
    ]);
  });

  it("preserves retryability through runner and history", async () => {
    const test = harness("all_or_nothing").targetFailsAt(
      0,
      new ConnectorError("ORA-03113", "connection lost", true),
    );

    const result = await test.runner.startRun(test.flowId);
    const event = test.repository.loadRun(result.runId)?.events()[0];

    expect(event).toMatchObject({
      type: "step_failed",
      error: { type: "connector", detail: { code: "ORA-03113", retryable: true } },
    });
  });

  it("persists commit failure as an indeterminate outcome without secrets", async () => {
    const secret = "commit-secret-fixture";
    const test = harness("all_or_nothing").commitFails(
      new ConnectorError("ORA-00942", `password=${secret}`),
    );

    const result = await test.runner.startRun(test.flowId);
    const state = test.repository.loadRun(result.runId)!;

    expect(result.status).toEqual({ in_doubt: expect.objectContaining({ step: 1 }) });
    expect(state.steps()[1].status).toEqual({ succeeded: { affected_rows: 1 } });
    expect(test.connector.targetTransactions()).toEqual([
      "begin",
      "execute:0",
      "execute:1",
      "commit",
      "rollback",
    ]);
    expect(test.repository.historyJsonForTest(result.runId)).not.toContain(secret);
  });

  it("uses keyring fallback and closes both recovery sessions when execution returns to pause", async () => {
    const credentials = new MemoryCredentials([
      ["source", "legacy-source"],
      ["credential://target", "target-secret"],
    ]);
    const test = harness("commit_successes")
      .withKeyringCredentials(credentials)
      .targetFailsAt(0);
    const paused = await test.runner.startRun(test.flowId);
    const closesAfterStart = test.connector.closedProfiles.length;
    test.targetFailsAt(1);

    const result = await test.runner.recoverRun(editRequest(paused.runId, {
      stepId: "customer",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    }));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 0 } });
    expect(credentials.stored).toContainEqual(["credential://source", "legacy-source"]);
    expect(test.connector.closedProfiles.slice(closesAfterStart)).toEqual(["target", "source"]);
  });
});

class RunnerHarness {
  readonly repository = SqliteRepository.inMemory();
  readonly connector: RecordingConnector;
  readonly flowId = "two-step-flow";
  runner: MigrationRunner;

  constructor(policy: TransactionPolicy) {
    this.connector = new RecordingConnector(policy === "commit_successes");
    saveFixture(this.repository, policy);
    this.runner = new MigrationRunner(this.connector, this.repository, this.repository);
  }

  close(): void {
    this.repository.close();
  }

  sourceRowsAt(step: number, rows: RowSet): this {
    this.connector.sourceRows.set(step, rows);
    return this;
  }

  sourceRowsForQuery(query: number, rows: RowSet): this {
    this.connector.sourceRowsByQuery.set(query, rows);
    return this;
  }

  sourceFailsAt(query: number, error: ConnectorError): this {
    this.connector.sourceFailures.set(query, error);
    return this;
  }

  targetFailsAt(step: number, error = new ConnectorError("FAKE_EXECUTE", "target write failed")): this {
    this.connector.targetFailures.set(step, error);
    return this;
  }

  commitFails(error: ConnectorError): this {
    this.connector.commitFailure = error;
    return this;
  }

  rollbackFails(error: ConnectorError): this {
    this.connector.rollbackFailure = error;
    return this;
  }

  openFailsFor(profileId: string): this {
    this.connector.openFailures.add(profileId);
    return this;
  }

  closeSynchronouslyFailsFor(profileId: string): this {
    this.connector.synchronousCloseFailures.add(profileId);
    return this;
  }

  stepSql(step: number, selectSql: string, upsertSql: string): this {
    this.repository.database.prepare(`
      UPDATE query_steps SET select_sql = ?, upsert_sql = ?
      WHERE flow_id = ? AND position = ?
    `).run(selectSql, upsertSql, this.flowId, step);
    return this;
  }

  withKeyringCredentials(credentials: CredentialResolver): this {
    for (const id of ["source", "target"] as const) {
      const profile = this.repository.loadConnection(id)!;
      this.repository.saveConnection({
        ...profile,
        credentialStorage: "keyring",
        plaintextPassword: undefined,
      });
    }
    this.runner = new MigrationRunner(
      this.connector,
      this.repository,
      this.repository,
      credentials,
    );
    return this;
  }
}

class RecordingConnector implements DatabaseConnectorFactory {
  readonly kind = "oracle" as const;
  readonly sourceRows = new Map<number, RowSet>([
    [0, rowSet("ID", 1)],
    [1, rowSet("ADDRESS_ID", 2)],
  ]);
  readonly sourceRowsByQuery = new Map<number, RowSet>();
  readonly sourceFailures = new Map<number, ConnectorError>();
  readonly targetFailures = new Map<number, ConnectorError>();
  readonly openFailures = new Set<string>();
  readonly synchronousCloseFailures = new Set<string>();
  readonly sourceQueries: string[] = [];
  readonly targetOperations: string[] = [];
  readonly executedSql: string[] = [];
  readonly openedProfiles: string[] = [];
  readonly closedProfiles: string[] = [];
  commitFailure?: ConnectorError;
  rollbackFailure?: ConnectorError;
  private sourceQueryCount = 0;
  private targetExecuteCount = 0;

  constructor(private readonly committedLabels: boolean) {}

  async open(profile: ConnectionProfile, _secret: string): Promise<DatabaseSession> {
    this.openedProfiles.push(profile.id);
    if (this.openFailures.has(profile.id)) {
      throw new ConnectorError("FAKE_OPEN", "connection failed");
    }
    return profile.id === "source" ? this.sourceSession(profile.id) : this.targetSession(profile.id);
  }

  targetTransactions(): string[] {
    return this.targetOperations.filter((operation) => operation !== "close");
  }

  private sourceSession(profileId: string): DatabaseSession {
    return {
      query: async (sql): Promise<RowSet> => {
        const query = this.sourceQueryCount++;
        const label = sql.toLowerCase().includes("address") ? "address" : "customer";
        this.sourceQueries.push(label);
        const failure = this.sourceFailures.get(query);
        if (failure !== undefined) throw failure;
        const override = this.sourceRowsByQuery.get(query);
        if (override !== undefined) return structuredClone(override);
        return structuredClone(this.sourceRows.get(label === "address" ? 1 : 0) ?? emptyRowSet());
      },
      begin: async () => undefined,
      executeNamed: async () => 0,
      commit: async () => undefined,
      rollback: async () => undefined,
      close: () => this.closeProfile(profileId),
    };
  }

  private targetSession(profileId: string): DatabaseSession {
    return {
      query: async () => emptyRowSet(),
      begin: async () => {
        this.targetOperations.push(this.committedLabels
          ? `begin:${this.targetExecuteCount}`
          : "begin");
      },
      executeNamed: async (sql: string, rows: readonly NamedRow[]) => {
        const execution = this.targetExecuteCount++;
        this.executedSql.push(sql);
        this.targetOperations.push(`execute:${execution}`);
        const failure = this.targetFailures.get(execution);
        if (failure !== undefined) throw failure;
        return rows.length;
      },
      commit: async () => {
        this.targetOperations.push(this.committedLabels
          ? `commit:${Math.max(0, this.targetExecuteCount - 1)}`
          : "commit");
        if (this.commitFailure !== undefined) throw this.commitFailure;
      },
      rollback: async () => {
        this.targetOperations.push(this.committedLabels
          ? `rollback:${Math.max(0, this.targetExecuteCount - 1)}`
          : "rollback");
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure;
      },
      close: () => {
        this.targetOperations.push("close");
        return this.closeProfile(profileId);
      },
    };
  }

  private closeProfile(profileId: string): Promise<void> {
    this.closedProfiles.push(profileId);
    if (this.synchronousCloseFailures.has(profileId)) {
      throw new ConnectorError("FAKE_CLOSE", "close failed");
    }
    return Promise.resolve();
  }
}

class MemoryCredentials implements CredentialResolver {
  private readonly values: Map<string, string>;
  readonly stored: Array<[string, string]> = [];

  constructor(entries: ReadonlyArray<readonly [string, string]>) {
    this.values = new Map(entries);
  }

  async resolve(account: string): Promise<string> {
    const secret = this.values.get(account);
    if (secret === undefined) {
      throw Object.assign(new Error("credential was not found"), { code: "CREDENTIAL_NOT_FOUND" });
    }
    return secret;
  }

  async store(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
    this.stored.push([account, secret]);
  }
}

function saveFixture(repository: SqliteRepository, transactionPolicy: TransactionPolicy): void {
  repository.saveConnection(connection("source"));
  repository.saveConnection(connection("target"));
  repository.saveFlow({
    id: "two-step-flow",
    name: "Two step flow",
    sourceConnectionId: "source",
    targetConnectionId: "target",
    querySteps: [
      {
        id: "customer",
        selectSql: "SELECT id FROM customer",
        upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
      },
      {
        id: "address",
        selectSql: "SELECT address_id FROM address",
        upsertSql: "MERGE INTO address USING dual ON (id = :ADDRESS_ID)",
      },
    ],
    transactionPolicy,
    version: 0,
  });
}

function connection(id: "source" | "target"): ConnectionProfile {
  return {
    id,
    displayName: id,
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: `credential://${id}`,
    credentialStorage: "plaintext",
    plaintextPassword: `${id}-secret`,
    enabled: true,
    sourceReadOnly: id === "source",
  };
}

function rowSet(column: string, value: DomainValue | Date): RowSet {
  return {
    columns: [column],
    unsupportedBindColumns: [],
    rows: [{ [column]: value as DomainValue }],
  };
}

function emptyRowSet(): RowSet {
  return { columns: [], unsupportedBindColumns: [], rows: [] };
}

function editRequest(
  runId: string,
  overrides: Partial<Extract<RecoveryRequest, { type: "edit_and_retry" }>> = {},
): Extract<RecoveryRequest, { type: "edit_and_retry" }> {
  return {
    type: "edit_and_retry",
    runId,
    stepId: "address",
    selectSql: "SELECT address_id FROM address",
    upsertSql: "MERGE INTO address USING dual ON (id = :ADDRESS_ID)",
    ...overrides,
  };
}
