# Oracle Workflow Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add opt-in tests that run registered DB Relay workflows against disposable Oracle tables and verify outcomes in both Oracle and run history.

**Architecture:** Tests start at createDbRelayCommandHandler, using real application services, a temporary SQLite repository, and OracleConnector. A fixture-only harness may issue controlled Oracle DDL and seed data; all application actions use typed IPC commands.

**Tech Stack:** TypeScript, Vitest 4, Electron main-process services, better-sqlite3, oracledb 6.2.

## Global Constraints

- Run only when DB_RELAY_ORACLE_TEST_URL is nonempty; otherwise every new test skips.
- The supplied Oracle account or schema is dedicated and disposable: the suite creates and drops tables.
- Store the test SQLite database in a newly created temporary directory, never in the user data directory.
- Keep Oracle URL, password, source rows, and bind values out of test output, public DTOs, and persisted-history assertions.
- The renderer and IPC still expose only typed commands: no generic SQL command is added.
- Run the architecture test after changes to IPC composition.

---

## File structure

- Create: electron/workflows/workflowTestHarness.ts — fixture lifecycle, typed handler composition, Oracle seed/query/cleanup helpers.
- Create: electron/workflows/workflow.integration.test.ts — opt-in end-to-end workflow scenarios.
- Modify: electron/ipc/architecture.test.ts — checks that active documentation records the destructive opt-in workflow suite.
- Modify: ARCHITECTURE.md — explains the workflow suite and its disposable-schema requirement.
- Modify: AGENTS.md — gives contributors the exact workflow-suite command.

### Task 1: Establish an isolated workflow fixture

**Files:**
- Create: electron/workflows/workflowTestHarness.ts
- Create: electron/workflows/workflow.integration.test.ts

**Interfaces:**
- Consumes: OracleConnector, SqliteRepository.open, SettingsService, FlowService, MigrationRunner, HistoryService, ConnectorRegistry, createDbRelayCommandHandler.
- Produces: createWorkflowHarness(url: string): Promise<WorkflowHarness>.
- Produces: WorkflowHarness.handler, saveConnections(), createFixture(), close(), and tables.

- [ ] **Step 1: Write the failing opt-in registration test**

~~~ts
const integrationTest = process.env.DB_RELAY_ORACLE_TEST_URL?.trim() ? it : it.skip;

integrationTest("registers distinct Oracle connections without returning the password", async () => {
  const test = await createWorkflowHarness(process.env.DB_RELAY_ORACLE_TEST_URL!);
  try {
    await test.saveConnections();
    const connections = await test.handler("list_connections");

    expect(connections).toHaveLength(2);
    expect(connections.every(({ passwordMask }) =>
      passwordMask === "*".repeat(test.passwordLength))).toBe(true);
    expect(JSON.stringify(connections)).not.toContain(test.secretSentinel);
  } finally {
    await test.close();
  }
}, 30_000);
~~~

- [ ] **Step 2: Run the test to verify it fails**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts

Expected: compilation fails because the harness is absent; after the harness exists, no Oracle URL makes the test skip.

- [ ] **Step 3: Implement the minimal harness and typed connection setup**

~~~ts
export type WorkflowHarness = {
  readonly handler: DbRelayCommandHandler;
  readonly passwordLength: number;
  readonly secretSentinel: string;
  readonly tables: WorkflowTables;
  saveConnections(): Promise<{ sourceId: string; targetId: string }>;
  createFixture(): Promise<void>;
  close(): Promise<void>;
};

export async function createWorkflowHarness(url: string): Promise<WorkflowHarness> {
  const endpoint = parseOracleTestUrl(url);
  const repository = SqliteRepository.open(createTempSqlitePath());
  const connector = new OracleConnector();
  const handler = createDbRelayCommandHandler({
    settings: new SettingsService(repository),
    flows: new FlowService(repository),
    runs: new MigrationRunner(connector, repository, repository),
    history: new HistoryService(repository),
    connectors: new ConnectorRegistry([connector]),
  });
  return createHarness(endpoint, repository, connector, handler);
}
~~~

Use save_connection twice with different IDs, workflow-source and workflow-target. Both profiles can reference the same disposable Oracle endpoint, but must have distinct saved IDs.

- [ ] **Step 4: Run the test to verify it passes or skips**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts

Expected: PASS with an Oracle endpoint; SKIP without one and no connection attempt.

- [ ] **Step 5: Commit**

~~~powershell
git add electron/workflows/workflowTestHarness.ts electron/workflows/workflow.integration.test.ts
git commit -m "test: add Oracle workflow integration harness"
~~~

### Task 2: Add deterministic tables, seed data, and a successful workflow

**Files:**
- Modify: electron/workflows/workflowTestHarness.ts
- Modify: electron/workflows/workflow.integration.test.ts

**Interfaces:**
- Consumes: WorkflowHarness.handler and tables.
- Produces: saveThreeStepFlow(policy, sourceId, targetId, options), readAllTargets(), and a safe close() that drops all generated tables.

- [ ] **Step 1: Write the failing all-or-nothing success test**

~~~ts
integrationTest("runs a registered all-or-nothing workflow against seeded Oracle tables", async () => {
  const test = await preparedWorkflow("all_or_nothing", { validOrdersOnly: true });
  try {
    const run = await test.handler("start_run", { request: { flowId: test.flowId } });

    expect(run.status).toBe("completed");
    expect(await test.readAllTargets()).toEqual({
      customers: [
        { CUSTOMER_ID: 1, LABEL: "workflow-customer-a" },
        { CUSTOMER_ID: 2, LABEL: "workflow-customer-b" },
      ],
      orders: [{ ORDER_ID: 101, AMOUNT: 10 }],
      audits: [{ AUDIT_ID: 1001, DETAIL: "workflow-audit" }],
    });
  } finally {
    await test.close();
  }
}, 30_000);
~~~

- [ ] **Step 2: Run the focused test to verify it fails**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "all-or-nothing workflow"

Expected: FAIL because the fixture, flow helper, and direct target read helper are absent.

- [ ] **Step 3: Implement table generation, DDL, seeds, and Flow registration**

~~~ts
const prefix = "DBR_WF_" + process.pid + "_" + randomSuffix();
const tables = {
  customerSource: prefix + "_SRC_CUSTOMER",
  orderSource: prefix + "_SRC_ORDER",
  auditSource: prefix + "_SRC_AUDIT",
  customerTarget: prefix + "_TGT_CUSTOMER",
  orderTarget: prefix + "_TGT_ORDER",
  auditTarget: prefix + "_TGT_AUDIT",
};

await session.executeNamed(createTableSql(tables.orderTarget,
  "order_id NUMBER PRIMARY KEY, amount NUMBER NOT NULL CHECK (amount > 0)"), [{}]);
await session.executeNamed(insertSql(tables.orderSource, ["ORDER_ID", "AMOUNT"]), [
  { ORDER_ID: 101, AMOUNT: 10 },
  { ORDER_ID: 102, AMOUNT: -1 },
]);
await session.commit();
~~~

Validate every generated table identifier with /^[A-Z][A-Z0-9_]*$/ before use. The saved flow has customer, order, and audit MERGE steps. In its successful form, the order SELECT filters amount > 0.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "all-or-nothing workflow"

Expected: PASS with the exact target rows shown in Step 1.

- [ ] **Step 5: Commit**

~~~powershell
git add electron/workflows/workflowTestHarness.ts electron/workflows/workflow.integration.test.ts
git commit -m "test: cover successful Oracle migration workflow"
~~~

### Task 3: Cover all-or-nothing rollback and preflight failure

**Files:**
- Modify: electron/workflows/workflow.integration.test.ts

**Interfaces:**
- Consumes: preparedWorkflow(policy, options), where options supports validOrdersOnly and missingCustomerBind.
- Produces: actual-table assertions for rolled_back and failed states.

- [ ] **Step 1: Write failing rollback and preflight tests**

~~~ts
integrationTest("rolls back every target change when all-or-nothing order processing fails", async () => {
  const test = await preparedWorkflow("all_or_nothing", { validOrdersOnly: false });
  try {
    await expect(test.handler("start_run", { request: { flowId: test.flowId } }))
      .resolves.toMatchObject({ status: "rolled_back" });
    expect(await test.readAllTargets()).toEqual({ customers: [], orders: [], audits: [] });
  } finally {
    await test.close();
  }
});

integrationTest("blocks an unmapped bind before it changes a target table", async () => {
  const test = await preparedWorkflow("all_or_nothing", { missingCustomerBind: true });
  try {
    await expect(test.handler("start_run", { request: { flowId: test.flowId } }))
      .resolves.toMatchObject({ status: "failed" });
    expect(await test.readAllTargets()).toEqual({ customers: [], orders: [], audits: [] });
  } finally {
    await test.close();
  }
});
~~~

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "rolls back|unmapped bind"

Expected: FAIL because the invalid-flow options are absent.

- [ ] **Step 3: Implement only the needed Flow variants**

~~~ts
const orderSelect = "SELECT order_id AS ORDER_ID, amount AS AMOUNT FROM " + tables.orderSource
  + (options.validOrdersOnly ? " WHERE amount > 0" : "");
const customerMerge = options.missingCustomerBind
  ? "MERGE INTO " + tables.customerTarget + " t USING (SELECT :MISSING_VALUE value FROM dual) s ON (1 = 0) WHEN NOT MATCHED THEN INSERT (customer_id, label) VALUES (:MISSING_VALUE, :MISSING_VALUE)"
  : customerMergeFor(tables.customerTarget);
~~~

The negative order must violate the target check constraint in step two. Assert only public run states; use direct fixture reads, not run responses, to inspect database contents.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "rolls back|unmapped bind"

Expected: PASS; both scenarios leave every target table empty.

- [ ] **Step 5: Commit**

~~~powershell
git add electron/workflows/workflow.integration.test.ts
git commit -m "test: cover Oracle workflow rollback and preflight"
~~~

### Task 4: Cover committed-step recovery actions

**Files:**
- Modify: electron/workflows/workflow.integration.test.ts

**Interfaces:**
- Consumes: pausedCommittedWorkflow(), a commit_successes run paused at step ID order.
- Produces: skip, stop, and edit-and-retry assertions through recover_run.

- [ ] **Step 1: Write failing recovery tests**

~~~ts
integrationTest("skips a failed committed step and continues with the next Oracle step", async () => {
  const test = await pausedCommittedWorkflow();
  try {
    const run = await test.handler("recover_run", {
      request: { type: "skip_and_continue", run_id: test.runId, step_id: "order" },
    });
    expect(run.status).toBe("completed");
    expect(await test.readAllTargets()).toEqual({
      customers: test.customerRows, orders: [], audits: test.auditRows,
    });
  } finally {
    await test.close();
  }
});

integrationTest("stops a paused committed workflow without executing later steps", async () => {
  const test = await pausedCommittedWorkflow();
  try {
    await expect(test.handler("recover_run", {
      request: { type: "stop", run_id: test.runId, step_id: "order" },
    })).resolves.toMatchObject({ status: "stopped_by_user" });
    expect(await test.readAllTargets()).toEqual({
      customers: test.customerRows, orders: [], audits: [],
    });
  } finally {
    await test.close();
  }
});

integrationTest("retries a revised failed step and continues the remaining workflow", async () => {
  const test = await pausedCommittedWorkflow();
  try {
    const run = await test.handler("recover_run", { request: retryRequest(test) });
    expect(run.status).toBe("completed");
    expect(await test.readAllTargets()).toEqual(test.allSuccessfulTargets);
    const history = await test.handler("list_run_history");
    expect(history.find(({ runId }) => runId === test.runId)).toMatchObject({
      flowVersion: 1,
      events: expect.arrayContaining([
        expect.objectContaining({ type: "recovery_applied", action: "edit_and_retry" }),
      ]),
    });
  } finally {
    await test.close();
  }
});
~~~

- [ ] **Step 2: Run the recovery tests to verify they fail**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "skips a failed|stops a paused"

Expected: FAIL because pausedCommittedWorkflow is absent.

- [ ] **Step 3: Implement paused-run and retry helpers**

~~~ts
async function pausedCommittedWorkflow() {
  const test = await preparedWorkflow("commit_successes", { validOrdersOnly: false });
  const run = await test.handler("start_run", { request: { flowId: test.flowId } });
  expect(run.status).toEqual({ awaiting_recovery: { failed_step: 1 } });
  return { ...test, runId: run.runId };
}

function retryRequest(test: PausedWorkflow) {
  return {
    type: "edit_and_retry" as const,
    run_id: test.runId,
    step_id: "order",
    select_sql: "SELECT order_id AS ORDER_ID, amount AS AMOUNT FROM " + test.tables.orderSource + " WHERE amount > 0",
    upsert_sql: test.orderMergeSql,
  };
}
~~~

The retry test in Step 1 must assert completed status, all three target groups present, a higher Flow version in list_run_history, and a recovery_applied event.

- [ ] **Step 4: Run the recovery tests to verify they pass**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "skips a failed|stops a paused|retries a revised"

Expected: PASS; database contents differ correctly for skip, stop, and retry.

- [ ] **Step 5: Commit**

~~~powershell
git add electron/workflows/workflow.integration.test.ts
git commit -m "test: cover Oracle committed-step recovery workflow"
~~~

### Task 5: Cover configuration changes, disabled connections, and safe projection

**Files:**
- Modify: electron/workflows/workflow.integration.test.ts

**Interfaces:**
- Consumes: pausedCommittedWorkflow, update_connection, disable_connection, list_connections, and list_run_history.
- Produces: recovery-configuration and safe-history regression coverage.

- [ ] **Step 1: Write failing boundary tests**

~~~ts
integrationTest("rejects recovery when the bound target connection changes", async () => {
  const test = await pausedCommittedWorkflow();
  try {
    await test.changeTargetHost("changed.example.test");
    await expect(test.handler("recover_run", {
      request: { type: "skip_and_continue", run_id: test.runId, step_id: "order" },
    })).rejects.toMatchObject({ code: "RECOVERY_CONFIG_MISMATCH" });
    expect(await test.readAllTargets()).toEqual({
      customers: test.customerRows, orders: [], audits: [],
    });
  } finally {
    await test.close();
  }
});

integrationTest("blocks disabled connections and keeps workflow public data safe", async () => {
  const test = await preparedWorkflow("all_or_nothing", { validOrdersOnly: true });
  try {
    await test.handler("disable_connection", { request: { connectionId: test.targetId } });
    await expect(test.handler("start_run", { request: { flowId: test.flowId } }))
      .rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    const publicData = JSON.stringify([
      await test.handler("list_connections"),
      await test.handler("list_run_history"),
    ]);
    expect(publicData).not.toContain(test.secretSentinel);
    expect(publicData).not.toContain("workflow-customer-a");
  } finally {
    await test.close();
  }
});
~~~

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "bound target connection|blocks disabled"

Expected: FAIL because changeTargetHost is absent.

- [ ] **Step 3: Implement IPC-only configuration changes**

~~~ts
async function changeTargetHost(test: PreparedWorkflow, host: string) {
  await test.handler("update_connection", { request: {
    id: test.targetId,
    displayName: "Workflow target",
    kind: "oracle",
    host,
    port: test.profile.port,
    sid: test.profile.sid,
    username: test.profile.username,
    enabled: true,
  } });
}
~~~

Attach changeTargetHost to the prepared-workflow return value. Do not edit repositories directly in this task; the test must validate the command-handler path.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: pnpm vitest run electron/workflows/workflow.integration.test.ts -t "bound target connection|blocks disabled"

Expected: PASS; neither rejected scenario writes additional target rows, and public DTO/history JSON excludes both sentinels.

- [ ] **Step 5: Commit**

~~~powershell
git add electron/workflows/workflow.integration.test.ts
git commit -m "test: protect Oracle workflow recovery boundaries"
~~~

### Task 6: Document and verify the opt-in suite

**Files:**
- Modify: electron/ipc/architecture.test.ts
- Modify: ARCHITECTURE.md
- Modify: AGENTS.md

**Interfaces:**
- Consumes: electron/workflows/workflow.integration.test.ts and DB_RELAY_ORACLE_TEST_URL.
- Produces: contributor documentation that separates connector-only integration coverage from destructive workflow coverage.

- [ ] **Step 1: Write the failing documentation assertion**

~~~ts
it("documents the opt-in disposable Oracle workflow suite", () => {
  const architecture = readFileSync(resolve(workspace, "ARCHITECTURE.md"), "utf8");
  expect(architecture).toContain("electron/workflows/workflow.integration.test.ts");
  expect(architecture).toMatch(/dedicated disposable Oracle (?:account|schema)/iu);
});
~~~

- [ ] **Step 2: Run the assertion to verify it fails**

Run: pnpm vitest run electron/ipc/architecture.test.ts -t "disposable Oracle workflow suite"

Expected: FAIL because active documentation does not yet describe the suite.

- [ ] **Step 3: Update the contributor documentation**

~~~markdown
The connector test and electron/workflows/workflow.integration.test.ts are opt-in.
The workflow suite creates, seeds, and drops tables, so DB_RELAY_ORACLE_TEST_URL
must identify a dedicated disposable Oracle account or schema.

pnpm vitest run electron/workflows/workflow.integration.test.ts
~~~

Add this wording to ARCHITECTURE.md and add the same command and safety constraint to AGENTS.md.

- [ ] **Step 4: Run all verification**

~~~powershell
pnpm vitest run electron/workflows/workflow.integration.test.ts
pnpm vitest run electron/ipc/architecture.test.ts
pnpm test
pnpm lint
pnpm build
pnpm package
~~~

Expected: without Oracle configuration, the workflow suite skips and all other commands pass. With a dedicated disposable endpoint, every workflow test passes and final cleanup removes its tables and temporary SQLite file.

- [ ] **Step 5: Commit**

~~~powershell
git add AGENTS.md ARCHITECTURE.md electron/ipc/architecture.test.ts
git commit -m "docs: document Oracle workflow integration tests"
~~~
