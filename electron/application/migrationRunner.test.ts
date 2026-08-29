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
  type RunProgress,
} from "./migrationRunner";
import { HistoryService } from "./historyService";

type TargetOperation = "insert" | "update" | "upsert";

const targetOperationCases: ReadonlyArray<{ name: TargetOperation }> = [
  { name: "insert" },
  { name: "update" },
  { name: "upsert" },
];

type MultiStepScenario = {
  name: string;
  operations: readonly TargetOperation[];
  transactions: readonly string[];
};

const allOrNothingSuccessScenarios: readonly MultiStepScenario[] = [
  {
    name: "three insert steps",
    operations: ["insert", "insert", "insert"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "commit"],
  },
  {
    name: "three upsert steps",
    operations: ["upsert", "upsert", "upsert"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "commit"],
  },
  {
    name: "one update, insert, and upsert step",
    operations: ["update", "insert", "upsert"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "commit"],
  },
  {
    name: "two insert, update, and upsert steps",
    operations: ["insert", "insert", "update", "update", "upsert", "upsert"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "execute:3", "execute:4", "execute:5", "commit"],
  },
];

const allOrNothingFailureScenarios: ReadonlyArray<MultiStepScenario & {
  failureAt: number;
  steps: readonly unknown[];
}> = [
  {
    name: "three update steps failing at step 3",
    operations: ["update", "update", "update"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "rollback"],
  },
  {
    name: "three insert steps failing at step 3",
    operations: ["insert", "insert", "insert"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "rollback"],
  },
  {
    name: "three upsert steps failing at step 3",
    operations: ["upsert", "upsert", "upsert"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "rollback"],
  },
  {
    name: "six mixed steps failing at step 3",
    operations: ["insert", "insert", "update", "update", "upsert", "upsert"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed", "not_run", "not_run", "not_run"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "rollback"],
  },
  {
    name: "six mixed steps failing at step 6",
    operations: ["insert", "insert", "update", "update", "upsert", "upsert"],
    failureAt: 5,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin", "execute:0", "execute:1", "execute:2", "execute:3", "execute:4", "execute:5", "rollback"],
  },
];

const committedSuccessScenarios: readonly MultiStepScenario[] = [
  {
    name: "three update steps",
    operations: ["update", "update", "update"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2"],
  },
  {
    name: "three insert steps",
    operations: ["insert", "insert", "insert"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2"],
  },
  {
    name: "three upsert steps",
    operations: ["upsert", "upsert", "upsert"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2"],
  },
  {
    name: "one update, insert, and upsert step",
    operations: ["update", "insert", "upsert"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2"],
  },
  {
    name: "two insert, update, and upsert steps",
    operations: ["insert", "insert", "update", "update", "upsert", "upsert"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2", "begin:3", "execute:3", "commit:3", "begin:4", "execute:4", "commit:4", "begin:5", "execute:5", "commit:5"],
  },
];

const committedFailureScenarios: ReadonlyArray<MultiStepScenario & {
  failureAt: number;
  steps: readonly unknown[];
}> = [
  {
    name: "three update steps failing at step 3",
    operations: ["update", "update", "update"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "rollback:2"],
  },
  {
    name: "three insert steps failing at step 3",
    operations: ["insert", "insert", "insert"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "rollback:2"],
  },
  {
    name: "three upsert steps failing at step 3",
    operations: ["upsert", "upsert", "upsert"],
    failureAt: 2,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "rollback:2"],
  },
  {
    name: "three mixed steps failing at step 2",
    operations: ["update", "insert", "upsert"],
    failureAt: 1,
    steps: [{ succeeded: { affected_rows: 1 } }, "failed", "not_run"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "rollback:1"],
  },
  {
    name: "six mixed steps failing at step 6",
    operations: ["insert", "insert", "update", "update", "upsert", "upsert"],
    failureAt: 5,
    steps: [{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }, "failed"],
    transactions: ["begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1", "begin:2", "execute:2", "commit:2", "begin:3", "execute:3", "commit:3", "begin:4", "execute:4", "commit:4", "begin:5", "execute:5", "rollback:5"],
  },
];

const batchBoundaryCases = [
  { label: "999 rows", rowCount: 999, chunkSizes: [999] },
  { label: "1,000 rows", rowCount: 1_000, chunkSizes: [1_000] },
  { label: "1,001 rows", rowCount: 1_001, chunkSizes: [1_000, 1] },
  { label: "3,000 rows", rowCount: 3_000, chunkSizes: [1_000, 1_000, 1_000] },
] as const;

const batchedTargetOperationCases = batchBoundaryCases.flatMap((boundary) => (
  targetOperationCases.map(({ name }) => ({ ...boundary, name }))
));

function targetSql(operation: TargetOperation, table: string, column: string): string {
  const field = column.toLowerCase();
  if (operation === "insert") return `INSERT INTO ${table} (${field}) VALUES (:${column})`;
  if (operation === "update") return `UPDATE ${table} SET ${field} = :${column} WHERE ${field} = :${column}`;
  return `MERGE INTO ${table} target USING dual ON (target.${field} = :${column}) WHEN MATCHED THEN UPDATE SET target.${field} = :${column} WHEN NOT MATCHED THEN INSERT (${field}) VALUES (:${column})`;
}

function configureOperationFlow(test: RunnerHarness, operation: TargetOperation): RunnerHarness {
  return test
    .stepSql(0, "SELECT id FROM customer", targetSql(operation, "customer", "ID"))
    .stepSql(1, "SELECT address_id FROM address", targetSql(operation, "address", "ADDRESS_ID"));
}

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

    expect(result).toEqual({
      previewId: expect.any(String),
      columns: ["ID"],
      rows: [{ ID: 1 }, { ID: 2 }],
    });
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

  it("runs a saved preview without opening or querying the source", async () => {
    const test = harness("all_or_nothing");
    const preview = await test.runner.previewFlowStep({
      sourceConnectionId: "source",
      selectSql: "SELECT id FROM customer",
    });
    test.runner.saveEditedPreview({
      previewId: preview.previewId,
      columns: ["ID"],
      rows: [{ ID: 7 }],
    });

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
      previewId: preview.previewId,
    })).resolves.toEqual({ affectedRows: 1 });

    expect(test.connector.sourceQueries).toEqual(["customer"]);
    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "commit"]);
    expect(test.connector.closedProfiles).toEqual(["source", "target"]);
  });

  it("discards a saved preview after a failed target run", async () => {
    const test = harness("all_or_nothing").targetFailsAt(0);
    const preview = await test.runner.previewFlowStep({
      sourceConnectionId: "source",
      selectSql: "SELECT id FROM customer",
    });
    test.runner.saveEditedPreview({
      previewId: preview.previewId,
      columns: ["ID"],
      rows: [{ ID: 7 }],
    });

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
      previewId: preview.previewId,
    })).rejects.toMatchObject({ code: "FAKE_EXECUTE" });

    expect(() => test.runner.saveEditedPreview({
      previewId: preview.previewId,
      columns: ["ID"],
      rows: [{ ID: 8 }],
    })).toThrow(/preview/i);
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

  it("executes a large all-or-nothing step in 1,000-row chunks and reports safe progress", async () => {
    // Would fail if target execution kept sending the whole step at once or
    // if the renderer-facing progress callback exposed no batch boundaries.
    const progress: RunProgress[] = [];
    const test = harness("all_or_nothing").sourceRowsAt(0, numberedRowSet("ID", 2_001));

    await test.runner.startRun(test.flowId, (update) => progress.push(update));

    expect(test.connector.executedRowCounts).toEqual([1_000, 1_000, 1, 1]);
    expect(progress.filter((update) => update.step === 0)).toEqual([
      {
        runId: expect.any(String), step: 0, processedRows: 1_000, totalRows: 2_001,
        completedBatches: 1, totalBatches: 3,
      },
      {
        runId: expect.any(String), step: 0, processedRows: 2_000, totalRows: 2_001,
        completedBatches: 2, totalBatches: 3,
      },
      {
        runId: expect.any(String), step: 0, processedRows: 2_001, totalRows: 2_001,
        completedBatches: 3, totalBatches: 3,
      },
    ]);
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

  it("runs when source and target use the same connection", async () => {
    const test = harness("all_or_nothing");
    test.repository.database.prepare(
      "UPDATE flows SET target_connection_id = source_connection_id WHERE id = ?",
    ).run(test.flowId);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.openedProfiles).toEqual(["source", "source"]);
  });

  it("runs a single step against the same source and target connection", async () => {
    const test = harness("all_or_nothing");

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "source",
      selectSql: "SELECT id FROM customer",
      upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    })).resolves.toEqual({ affectedRows: 0 });
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

  it("keeps the flow name in history after an all-or-nothing run", async () => {
    const test = harness("all_or_nothing");
    const titled = test.repository.loadFlow(test.flowId)!;
    test.repository.saveFlow({
      ...titled,
      querySteps: titled.querySteps.map((step, index) => ({
        ...step,
        title: index === 0 ? "Load customers" : "Load addresses",
      })),
    });

    const result = await test.runner.startRun(test.flowId);
    const history = await new HistoryService(test.repository).listRunHistory();

    expect(result.status).toBe("completed");
    expect(history[0]).toMatchObject({
      runId: result.runId,
      flowId: test.flowId,
      flowName: "Two step flow",
      stepTitles: ["Load customers", "Load addresses"],
    });
    expect(result.stepTitles).toEqual(["Load customers", "Load addresses"]);
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

  it.each(targetOperationCases)("runs $name steps in one all-or-nothing transaction", async ({ name }) => {
    const test = configureOperationFlow(harness("all_or_nothing"), name);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "execute:1", "commit"]);
  });

  it("commits all three update steps in one all-or-nothing transaction", async () => {
    // Would fail if a three-step all-or-nothing run committed per step or
    // omitted the final step from its single transaction.
    const test = harness("all_or_nothing");
    (test as unknown as {
      configureOperationSteps: (operations: readonly TargetOperation[]) => RunnerHarness;
    }).configureOperationSteps(["update", "update", "update"]);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.targetTransactions()).toEqual([
      "begin", "execute:0", "execute:1", "execute:2", "commit",
    ]);
  });

  it.each(allOrNothingSuccessScenarios)(
    "commits $name in one all-or-nothing transaction",
    async ({ operations, transactions }) => {
      const test = harness("all_or_nothing").configureOperationSteps(operations);

      const result = await test.runner.startRun(test.flowId);

      expect(result.status).toBe("completed");
      expect(test.connector.targetTransactions()).toEqual(transactions);
    },
  );

  it.each(allOrNothingFailureScenarios)(
    "rolls back $name without committing earlier steps",
    async ({ operations, failureAt, steps, transactions }) => {
      const test = harness("all_or_nothing")
        .configureOperationSteps(operations)
        .targetFailsAt(failureAt);

      const result = await test.runner.startRun(test.flowId);

      expect(result.status).toBe("rolled_back");
      expect(result.steps).toEqual(steps);
      expect(test.connector.targetTransactions()).toEqual(transactions);
    },
  );

  it.each(committedSuccessScenarios)(
    "commits $name step by step under commit-successes",
    async ({ operations, transactions }) => {
      const test = harness("commit_successes").configureOperationSteps(operations);

      const result = await test.runner.startRun(test.flowId);

      expect(result.status).toBe("completed");
      expect(test.connector.targetTransactions()).toEqual(transactions);
    },
  );

  it.each(committedFailureScenarios)(
    "preserves earlier commits for $name under commit-successes",
    async ({ operations, failureAt, steps, transactions }) => {
      const test = harness("commit_successes")
        .configureOperationSteps(operations)
        .targetFailsAt(failureAt);

      const result = await test.runner.startRun(test.flowId);

      expect(result.status).toEqual({ awaiting_recovery: { failed_step: failureAt } });
      expect(result.steps).toEqual(steps);
      expect(test.connector.targetTransactions()).toEqual(transactions);
    },
  );

  it("skips a failed update step and commits the remaining third step", async () => {
    // Would fail if skipping a failed step reran or rolled back the first commit,
    // or if it did not continue to the remaining step.
    const operations: readonly TargetOperation[] = ["update", "update", "update"];
    const test = harness("commit_successes")
      .configureOperationSteps(operations)
      .targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({
      type: "skip_and_continue",
      runId: paused.runId,
      stepId: "update-step-2",
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([
      { succeeded: { affected_rows: 1 } },
      "skipped_by_user",
      { succeeded: { affected_rows: 1 } },
    ]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0",
      "begin:1", "execute:1", "rollback:1",
      "begin:2", "execute:2", "commit:2",
    ]);
  });

  it("stops after a failed insert step without executing the remaining third step", async () => {
    // Would fail if stop rolled back the first committed step or continued the run.
    const operations: readonly TargetOperation[] = ["insert", "insert", "insert"];
    const test = harness("commit_successes")
      .configureOperationSteps(operations)
      .targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({
      type: "stop",
      runId: paused.runId,
      stepId: "insert-step-2",
    });

    expect(result.status).toBe("stopped_by_user");
    expect(result.steps).toEqual([
      { succeeded: { affected_rows: 1 } },
      "failed",
      "not_run",
    ]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0",
      "begin:1", "execute:1", "rollback:1",
    ]);
  });

  it("edits and retries a failed upsert step before committing the remaining third step", async () => {
    // Would fail if edit-and-retry reran the first committed step or did not use
    // the user-supplied replacement SQL for the failed step.
    const operations: readonly TargetOperation[] = ["upsert", "upsert", "upsert"];
    const test = harness("commit_successes")
      .configureOperationSteps(operations)
      .targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequestForOperationStep(
      paused.runId,
      operations,
      1,
    ));

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
    ]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0",
      "begin:1", "execute:1", "rollback:1",
      "begin:2", "execute:2", "commit:2",
      "begin:3", "execute:3", "commit:3",
    ]);
    expect(test.connector.executedSql[2]).toContain("revised_upsert_step_2");
  });

  it("edits a failed insert step in a mixed three-step flow and completes it", async () => {
    const operations: readonly TargetOperation[] = ["update", "insert", "upsert"];
    const test = harness("commit_successes")
      .configureOperationSteps(operations)
      .targetFailsAt(1);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequestForOperationStep(
      paused.runId,
      operations,
      1,
    ));

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
    ]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0",
      "begin:1", "execute:1", "rollback:1",
      "begin:2", "execute:2", "commit:2",
      "begin:3", "execute:3", "commit:3",
    ]);
    expect(test.connector.executedSql[2]).toContain("revised_insert_step_2");
  });

  it("edits a failed third step in a mixed six-step flow and commits every remaining step", async () => {
    const operations: readonly TargetOperation[] = [
      "insert", "insert", "update", "update", "upsert", "upsert",
    ];
    const test = harness("commit_successes")
      .configureOperationSteps(operations)
      .targetFailsAt(2);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequestForOperationStep(
      paused.runId,
      operations,
      2,
    ));

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
      { succeeded: { affected_rows: 1 } },
    ]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0",
      "begin:1", "execute:1", "commit:1",
      "begin:2", "execute:2", "rollback:2",
      "begin:3", "execute:3", "commit:3",
      "begin:4", "execute:4", "commit:4",
      "begin:5", "execute:5", "commit:5",
      "begin:6", "execute:6", "commit:6",
    ]);
    expect(test.connector.executedSql[3]).toContain("revised_update_step_3");
  });

  it.each(targetOperationCases)("rolls back all $name work when the later step fails", async ({ name }) => {
    const test = configureOperationFlow(harness("all_or_nothing").targetFailsAt(1), name);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("rolled_back");
    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "execute:1", "rollback"]);
  });

  it.each(targetOperationCases)("commits every successful $name step independently", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes"), name);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toBe("completed");
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "commit:1",
    ]);
  });

  it.each(targetOperationCases)("awaits recovery when the first committed $name step fails", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes").targetFailsAt(0), name);

    const result = await test.runner.startRun(test.flowId);

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 0 } });
    expect(test.connector.targetTransactions()).toEqual(["begin:0", "execute:0", "rollback:0"]);
  });

  it.each(targetOperationCases)("skips a later failed $name step without undoing an earlier commit", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes").targetFailsAt(1), name);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({ type: "skip_and_continue", runId: paused.runId, stepId: "address" });

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([{ succeeded: { affected_rows: 1 } }, "skipped_by_user"]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "rollback:1",
    ]);
  });

  it.each(targetOperationCases)("stops after a later failed $name step and preserves its earlier commit", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes").targetFailsAt(1), name);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun({ type: "stop", runId: paused.runId, stepId: "address" });

    expect(result.status).toBe("stopped_by_user");
    expect(result.steps[0]).toEqual({ succeeded: { affected_rows: 1 } });
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "rollback:1",
    ]);
  });

  it.each(targetOperationCases)("retries a later failed $name step after editing it without rerunning the committed step", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes").targetFailsAt(1), name);
    const paused = await test.runner.startRun(test.flowId);

    const result = await test.runner.recoverRun(editRequest(paused.runId, {
      selectSql: "SELECT address_id FROM revised_address",
      upsertSql: targetSql(name, "revised_address", "ADDRESS_ID"),
    }));

    expect(result.status).toBe("completed");
    expect(result.steps).toEqual([{ succeeded: { affected_rows: 1 } }, { succeeded: { affected_rows: 1 } }]);
    expect(test.connector.targetTransactions()).toEqual([
      "begin:0", "execute:0", "commit:0", "begin:1", "execute:1", "rollback:1", "begin:2", "execute:2", "commit:2",
    ]);
    expect(test.connector.executedSql).toHaveLength(3);
    expect(test.connector.executedSql[2]).toContain("revised_address");
  });

  it.each(targetOperationCases)("keeps the paused $name flow unchanged when its edit is invalid", async ({ name }) => {
    const test = configureOperationFlow(harness("commit_successes").targetFailsAt(1), name);
    const paused = await test.runner.startRun(test.flowId);
    const before = test.repository.loadFlow(test.flowId);

    const result = await test.runner.recoverRun(editRequest(paused.runId, { upsertSql: "DELETE FROM address" }));

    expect(result.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(test.repository.loadFlow(test.flowId)).toEqual(before);
  });

  it.each(batchedTargetOperationCases)(
    "runs $name with $label in all-or-nothing batches and reports every completed batch",
    async ({ name, rowCount, chunkSizes }) => {
      // Would fail if any boundary size were sent as a single target write, or
      // if the run-progress callback missed a completed target batch.
      const progress: RunProgress[] = [];
      const test = configureOperationFlow(harness("all_or_nothing"), name)
        .sourceRowsAt(0, numberedRowSet("ID", rowCount))
        .sourceRowsAt(1, numberedRowSet("ADDRESS_ID", rowCount));

      const result = await test.runner.startRun(test.flowId, (update) => progress.push(update));

      expect(result.status).toBe("completed");
      expect(result.steps).toEqual([
        { succeeded: { affected_rows: rowCount } },
        { succeeded: { affected_rows: rowCount } },
      ]);
      expect(test.connector.executedRowCounts).toEqual([...chunkSizes, ...chunkSizes]);
      expect(test.connector.targetTransactions()).toEqual([
        "begin",
        ...Array.from({ length: chunkSizes.length * 2 }, (_, index) => `execute:${index}`),
        "commit",
      ]);
      expect(progress.map((update) => ({
        step: update.step,
        processedRows: update.processedRows,
        totalRows: update.totalRows,
        completedBatches: update.completedBatches,
        totalBatches: update.totalBatches,
      }))).toEqual([
        ...batchProgress(0, rowCount, chunkSizes),
        ...batchProgress(1, rowCount, chunkSizes),
      ]);
    },
  );

  it.each(batchedTargetOperationCases)(
    "rolls back all $name batches with $label when the later step fails",
    async ({ name, rowCount, chunkSizes }) => {
      // Would fail if the first step were committed, or if a later-step
      // failure did not roll the transaction containing every completed batch back.
      const test = configureOperationFlow(
        harness("all_or_nothing").targetFailsAt(chunkSizes.length),
        name,
      )
        .sourceRowsAt(0, numberedRowSet("ID", rowCount))
        .sourceRowsAt(1, numberedRowSet("ADDRESS_ID", rowCount));

      const result = await test.runner.startRun(test.flowId);

      expect(result.status).toBe("rolled_back");
      expect(test.connector.executedRowCounts).toEqual([...chunkSizes, chunkSizes[0]]);
      expect(test.connector.targetTransactions()).toEqual([
        "begin",
        ...Array.from({ length: chunkSizes.length + 1 }, (_, index) => `execute:${index}`),
        "rollback",
      ]);
    },
  );

  it.each(batchedTargetOperationCases)(
    "preserves committed $name batches with $label and retries the edited failed step",
    async ({ name, rowCount, chunkSizes }) => {
      // Would fail if commit-successes rolled the first completed step back,
      // or if edit-and-retry reran that committed step instead of only the failed one.
      const progress: RunProgress[] = [];
      const test = configureOperationFlow(
        harness("commit_successes").targetFailsAt(chunkSizes.length),
        name,
      )
        .sourceRowsAt(0, numberedRowSet("ID", rowCount))
        .sourceRowsAt(1, numberedRowSet("ADDRESS_ID", rowCount));

      const paused = await test.runner.startRun(test.flowId, (update) => progress.push(update));

      expect(paused.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
      expect(paused.steps).toEqual([
        { succeeded: { affected_rows: rowCount } },
        "failed",
      ]);
      expect(test.connector.targetTransactions()).toEqual([
        "begin:0",
        ...Array.from({ length: chunkSizes.length }, (_, index) => `execute:${index}`),
        `commit:${chunkSizes.length - 1}`,
        `begin:${chunkSizes.length}`,
        `execute:${chunkSizes.length}`,
        `rollback:${chunkSizes.length}`,
      ]);

      const result = await test.runner.recoverRun(editRequest(paused.runId, {
        selectSql: "SELECT address_id FROM revised_address",
        upsertSql: targetSql(name, "revised_address", "ADDRESS_ID"),
      }), (update) => progress.push(update));

      expect(result.status).toBe("completed");
      expect(result.steps).toEqual([
        { succeeded: { affected_rows: rowCount } },
        { succeeded: { affected_rows: rowCount } },
      ]);
      expect(test.connector.executedRowCounts).toEqual([
        ...chunkSizes,
        chunkSizes[0],
        ...chunkSizes,
      ]);
      expect(test.connector.targetTransactions()).toEqual([
        "begin:0",
        ...Array.from({ length: chunkSizes.length }, (_, index) => `execute:${index}`),
        `commit:${chunkSizes.length - 1}`,
        `begin:${chunkSizes.length}`,
        `execute:${chunkSizes.length}`,
        `rollback:${chunkSizes.length}`,
        `begin:${chunkSizes.length + 1}`,
        ...Array.from(
          { length: chunkSizes.length },
          (_, index) => `execute:${chunkSizes.length + 1 + index}`,
        ),
        `commit:${chunkSizes.length * 2}`,
      ]);
      expect(test.connector.executedSql.slice(chunkSizes.length + 1).every((sql) => (
        sql.includes("revised_address")
      ))).toBe(true);
      expect(progress.map((update) => ({
        step: update.step,
        processedRows: update.processedRows,
        totalRows: update.totalRows,
        completedBatches: update.completedBatches,
        totalBatches: update.totalBatches,
      }))).toEqual([
        ...batchProgress(0, rowCount, chunkSizes),
        ...batchProgress(1, rowCount, chunkSizes),
      ]);
    },
  );

  it.each(targetOperationCases)("runs the current unsaved $name step in its own transaction", async ({ name }) => {
    const test = harness("all_or_nothing");

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: targetSql(name, "customer", "ID"),
    })).resolves.toEqual({ affectedRows: 1 });

    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "commit"]);
  });

  it.each(targetOperationCases)("rolls back a failed current unsaved $name step", async ({ name }) => {
    const test = harness("all_or_nothing").targetFailsAt(0);

    await expect(test.runner.runFlowStep({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      selectSql: "SELECT id FROM customer",
      upsertSql: targetSql(name, "customer", "ID"),
    })).rejects.toMatchObject({ code: "FAKE_EXECUTE" });

    expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "rollback"]);
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

  configureOperationSteps(operations: readonly TargetOperation[]): this {
    const flow = this.repository.loadFlow(this.flowId)!;
    this.repository.saveFlow({
      ...flow,
      querySteps: operations.map((operation, index) => {
        const position = index + 1;
        const column = `VALUE_${position}`;
        const table = `${operation}_step_${position}`;
        this.connector.sourceRows.set(index, rowSet(column, position));
        return {
          id: `${operation}-step-${position}`,
          selectSql: `SELECT ${column} FROM ${table}`,
          upsertSql: targetSql(operation, table, column),
        };
      }),
    });
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
  readonly executedRowCounts: number[] = [];
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
        const selectedColumn = /^\s*SELECT\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql)?.[1]?.toUpperCase();
        this.sourceQueries.push(label);
        const failure = this.sourceFailures.get(query);
        if (failure !== undefined) throw failure;
        const override = this.sourceRowsByQuery.get(query);
        if (override !== undefined) return structuredClone(override);
        return structuredClone(
          this.sourceRows.get(query)
          ?? (selectedColumn?.startsWith("VALUE_") ? rowSet(selectedColumn, query + 1) : undefined)
          ?? this.sourceRows.get(label === "address" ? 1 : 0)
          ?? emptyRowSet(),
        );
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
        this.executedRowCounts.push(rows.length);
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

function numberedRowSet(column: string, count: number): RowSet {
  return {
    columns: [column],
    unsupportedBindColumns: [],
    rows: Array.from({ length: count }, (_, index) => ({ [column]: index + 1 })),
  };
}

function batchProgress(step: number, totalRows: number, chunkSizes: readonly number[]): Array<Omit<RunProgress, "runId">> {
  let processedRows = 0;
  return chunkSizes.map((size, index) => {
    processedRows += size;
    return {
      step,
      processedRows,
      totalRows,
      completedBatches: index + 1,
      totalBatches: chunkSizes.length,
    };
  });
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

function editRequestForOperationStep(
  runId: string,
  operations: readonly TargetOperation[],
  failedStep: number,
): Extract<RecoveryRequest, { type: "edit_and_retry" }> {
  const operation = operations[failedStep]!;
  const position = failedStep + 1;
  const column = `VALUE_${position}`;
  const table = `revised_${operation}_step_${position}`;
  return {
    type: "edit_and_retry",
    runId,
    stepId: `${operation}-step-${position}`,
    selectSql: `SELECT ${column} FROM ${table}`,
    upsertSql: targetSql(operation, table, column),
  };
}
