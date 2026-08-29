# Flow Step Titles and Same-Connection Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Persist descriptive query-step titles, display their stable snapshots in execution and history, permit source and target to be the same connection, and update the protected-connection deletion copy.

**Architecture:** Query-step titles are normalized at the application boundary and saved in the existing \`query_steps\` relation. Runs copy only the ordered, resolved title list into their existing safe JSON history payload, so current runs and history share a stable label without exposing SQL, binds, passwords, or source rows. Renderer helpers resolve labels from that safe list and preserve an ordinal fallback for legacy records.

**Tech Stack:** Electron main process, React, TypeScript, better-sqlite3, Vitest, Testing Library, pnpm.

**Spec:** \`docs/superpowers/specs/2026-08-28-flow-step-title-and-same-connection-design.md\`

## Global Constraints

- Existing flows with absent or blank titles resolve to \`Step {position}\` and save that value on their next save.
- Existing history without captured titles falls back to \`Step {position}\`.
- History, IPC, renderer logs, SQLite, and tests must not expose passwords, credentials, bind values, source SQL, target SQL, or source rows beyond the existing explicitly permitted preview path.
- Source and target using one connection must still use independent database sessions and retain all enabled-state, connector-kind, SQL, transaction, and recovery validation.
- The exact protected-connection deletion message is \`flow에서 사용중이라 삭제할 수 없습니다.\`.

---

## File structure

- \`electron/domain/models.ts\`: typed query-step title property.
- \`electron/application/flowService.ts\`: title normalization before validation and persistence.
- \`electron/application/flowTransferService.ts\`: accepts legacy exported steps and normalizes current title-bearing flows.
- \`electron/infrastructure/sqliteRepository.ts\`: additive \`query_steps.title\` migration, persistence, and safe run-title snapshots.
- \`electron/application/ports.ts\`, \`historyService.ts\`, and \`migrationRunner.ts\`: run/history title-list contract.
- \`electron/ipc/commands.ts\`, \`handlers.ts\`, \`preload.ts\`, \`src/lib/desktop.ts\`, and \`src/types/electron-api.d.ts\`: typed IPC contract.
- \`src/features/flows/FlowEditor.tsx\` and \`QueryStepEditor.tsx\`: editable Step title field and defaults.
- \`src/features/run/RunDashboard.tsx\`, \`RunLog.tsx\`, and \`run.types.tsx\`: title-based live labels.
- \`src/features/history/RunDetail.tsx\`: title-based history labels.
- \`src/features/connections/ConnectionList.tsx\`: requested Korean message.

### Task 1: Persist and normalize flow step titles

**Files:**
- Modify: \`electron/domain/models.ts\`, \`electron/application/flowService.ts\`, \`electron/application/flowService.test.ts\`
- Modify: \`electron/infrastructure/sqliteRepository.ts\`, \`electron/infrastructure/sqliteRepository.test.ts\`
- Modify: \`electron/application/flowTransferService.ts\`, \`electron/application/flowTransferService.test.ts\`, \`electron/infrastructure/flowFileTransfer.test.ts\`

**Interfaces:**
- Produces: \`QueryStep.title: string\` and the positional default \`Step \${position + 1}\`.
- Produces: \`FlowService.saveFlow()\` returning the repository-reloaded normalized flow.
- Consumes: legacy SQLite rows and transfer files whose steps have no title.

- [ ] **Step 1: Write the failing service and repository tests**

\`\`\`ts
it("normalizes absent and whitespace-only titles by position before saving", async () => {
  const saved = await service.saveFlow({ ...flow(), querySteps: [
    { id: "one", title: "", selectSql: "SELECT id FROM source_table", upsertSql: "UPDATE target_table SET id = :id" },
    { id: "two", title: "  ", selectSql: "SELECT name FROM source_table", upsertSql: "UPDATE target_table SET name = :name" },
  ] });
  expect(saved.querySteps.map((step) => step.title)).toEqual(["Step 1", "Step 2"]);
});
\`\`\`

Also seed a pre-title \`query_steps\` row and assert \`loadFlow()\` resolves it to \`Step 1\`; then save a renamed step and assert the title column round-trips. Add an import test proving legacy step objects without \`title\` remain accepted.

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run electron/application/flowService.test.ts electron/application/flowTransferService.test.ts electron/infrastructure/flowFileTransfer.test.ts electron/infrastructure/sqliteRepository.test.ts\`

Expected: FAIL because \`title\` does not exist in the model or persistence.

- [ ] **Step 3: Write minimal implementation**

Add \`title\` to \`QueryStep\`. Make \`FlowService.saveFlow()\` create a cloned normalized flow before validation and repository calls:

\`\`\`ts
querySteps: flow.querySteps.map((step, position) => ({
  ...step,
  title: step.title.trim() || \`Step \${position + 1}\`,
}))
\`\`\`

Add \`title TEXT NOT NULL DEFAULT ''\` to the \`query_steps\` creation/rebuild schema through \`addColumnIfMissing\`, insert/select it in \`replaceFlowSteps()\` and \`loadFlowDirect()\`, and return the positional fallback from \`queryStepFromRow()\` for old blank values. Transfer-file validation accepts steps with an optional string \`title\`; exports use normalized data.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run electron/application/flowService.test.ts electron/application/flowTransferService.test.ts electron/infrastructure/flowFileTransfer.test.ts electron/infrastructure/sqliteRepository.test.ts\`

Expected: PASS, including explicit-title round trip and legacy fallback.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add electron/domain/models.ts electron/application/flowService.ts electron/application/flowService.test.ts electron/application/flowTransferService.ts electron/application/flowTransferService.test.ts electron/infrastructure/flowFileTransfer.test.ts electron/infrastructure/sqliteRepository.ts electron/infrastructure/sqliteRepository.test.ts
git commit -m "feat: persist flow step titles"
\`\`\`

### Task 2: Capture and expose safe title snapshots for runs and history

**Files:**
- Modify: \`electron/application/ports.ts\`, \`electron/application/historyService.ts\`, \`electron/application/historyService.test.ts\`
- Modify: \`electron/application/migrationRunner.ts\`, \`electron/application/migrationRunner.test.ts\`
- Modify: \`electron/infrastructure/sqliteRepository.ts\`, \`electron/infrastructure/sqliteRepository.test.ts\`
- Modify: \`electron/ipc/commands.ts\`, \`electron/ipc/handlers.ts\`, \`electron/ipc/handlers.test.ts\`, \`electron/preload.ts\`, \`electron/preload.test.ts\`
- Modify: \`src/lib/desktop.ts\`, \`src/lib/desktop.test.ts\`, \`src/types/electron-api.d.ts\`

**Interfaces:**
- Produces: \`RunDto.stepTitles: string[]\`, \`HistoryRunDto.stepTitles: string[]\`, and optional \`RunHistoryEntry.stepTitles\`.
- Consumes: the ordered normalized \`Flow.querySteps\` list at run creation only.

- [ ] **Step 1: Write the failing snapshot and IPC tests**

\`\`\`ts
it("returns titles captured when the run started after the flow is later renamed", async () => {
  const run = await runner.startRun("flow-1");
  await flows.saveFlow({ ...renamedFlow, querySteps: [{ ...renamedFlow.querySteps[0], title: "New title" }] });
  expect(run.stepTitles).toEqual(["Original title"]);
  await expect(history.listRunHistory()).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ stepTitles: ["Original title"] }),
  ]));
});
\`\`\`

Add an IPC test with a distinctive SQL sentinel and assert its string is absent from serialized run/history values while \`stepTitles\` is present.

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run electron/application/historyService.test.ts electron/application/migrationRunner.test.ts electron/infrastructure/sqliteRepository.test.ts electron/ipc/handlers.test.ts electron/preload.test.ts src/lib/desktop.test.ts\`

Expected: FAIL because \`stepTitles\` is absent.

- [ ] **Step 3: Write minimal implementation**

Add \`step_titles?: string[]\` to \`StoredRun\`; set it in \`storedRunFromBinding()\` from the resolved flow titles, and preserve it on later writes of the same run. Project it through \`RunHistoryEntry\`, \`HistoryService\`, \`RunDto\`, \`HistoryRunDto\`, handler projection, preload, and desktop types. Change \`snapshot(runId, state, stepTitles)\` callers in start/recover paths to pass the flow-derived list, including preflight failures. Never add SQL or bind values to \`StoredRun\` or a DTO.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run electron/application/historyService.test.ts electron/application/migrationRunner.test.ts electron/infrastructure/sqliteRepository.test.ts electron/ipc/handlers.test.ts electron/preload.test.ts src/lib/desktop.test.ts electron/ipc/architecture.test.ts\`

Expected: PASS; architecture test preserves the process-boundary restriction.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add electron/application/ports.ts electron/application/historyService.ts electron/application/historyService.test.ts electron/application/migrationRunner.ts electron/application/migrationRunner.test.ts electron/infrastructure/sqliteRepository.ts electron/infrastructure/sqliteRepository.test.ts electron/ipc/commands.ts electron/ipc/handlers.ts electron/ipc/handlers.test.ts electron/preload.ts electron/preload.test.ts src/lib/desktop.ts src/lib/desktop.test.ts src/types/electron-api.d.ts
git commit -m "feat: snapshot step titles in run history"
\`\`\`

### Task 3: Support one connection for source and target

**Files:**
- Modify: \`src/features/run/RunDashboard.tsx\`, \`src/features/run/RunDashboard.test.tsx\`
- Modify: \`electron/application/migrationRunner.ts\`, \`electron/application/migrationRunner.test.ts\`

**Interfaces:**
- Produces: run preflight that accepts \`source.id === target.id\` for an enabled connection with valid step SQL.
- Produces: recovery opens separate source and target sessions even when profile IDs match.

- [ ] **Step 1: Write the failing dashboard and recovery tests**

\`\`\`tsx
it("enables Run when a flow uses one enabled connection for source and target", () => {
  render(<RunDashboard initialFlows={[sameConnectionFlow]} initialConnections={[enabledConnection]} />);
  expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
});
\`\`\`

Add a recovery test that invokes recovery for a same-connection flow and asserts \`connector.open\` is called twice.

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run src/features/run/RunDashboard.test.tsx electron/application/migrationRunner.test.ts\`

Expected: FAIL because equal connection IDs are explicitly rejected.

- [ ] **Step 3: Write minimal implementation**

Remove only \`source.id !== target.id\` from \`preflightReady\`. In \`tryOpenBoundSessions()\`, retain both connector-kind checks but remove the equal-ID rejection. Preserve both existing \`connector.open()\` calls, cleanup, and transactions.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run src/features/run/RunDashboard.test.tsx electron/application/migrationRunner.test.ts\`

Expected: PASS with two independently closable sessions.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add src/features/run/RunDashboard.tsx src/features/run/RunDashboard.test.tsx electron/application/migrationRunner.ts electron/application/migrationRunner.test.ts
git commit -m "feat: allow same source and target connection"
\`\`\`

### Task 4: Edit and display step titles in React

**Files:**
- Modify: \`src/features/flows/flows.types.tsx\`, \`FlowEditor.tsx\`, \`FlowEditor.test.tsx\`, \`QueryStepEditor.tsx\`, \`QueryStepEditor.test.tsx\`
- Modify: \`src/features/run/run.types.tsx\`, \`RunDashboard.tsx\`, \`RunDashboard.test.tsx\`, \`RunLog.tsx\`, \`RunLog.test.tsx\`
- Modify: \`src/features/history/RunDetail.tsx\`, \`RunDetail.test.tsx\`

**Interfaces:**
- Produces: \`stepLabel(stepTitles, index): string\`, returning the nonblank captured title or \`Step \${index + 1}\`.
- Consumes: \`Run.stepTitles\` and \`HistoryRun.stepTitles\`.

- [ ] **Step 1: Write the failing editor and label-display tests**

\`\`\`tsx
it("starts steps at Step 1 and gives each added step its ordinal title", () => {
  render(<FlowEditor connections={connections} onSave={onSave} />);
  expect(screen.getByLabelText("Step title for step 1")).toHaveValue("Step 1");
  fireEvent.click(screen.getByRole("button", { name: "Add step" }));
  expect(screen.getByLabelText("Step title for step 2")).toHaveValue("Step 2");
});
\`\`\`

Render two-step run and history entries with \`["Load customers", "Apply customers"]\` and assert results, events, and \`RunLog\` use those names rather than ordinal-only labels. Include a legacy empty-list assertion for \`Step 1\`.

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run src/features/flows/FlowEditor.test.tsx src/features/flows/QueryStepEditor.test.tsx src/features/run/RunDashboard.test.tsx src/features/run/RunLog.test.tsx src/features/history/RunDetail.test.tsx\`

Expected: FAIL because no title input or label resolver exists.

- [ ] **Step 3: Write minimal implementation**

Make \`newStep(position)\` return \`title: \`Step \${position + 1}\`\` and use the current count while adding. On initial editor load and submit, map missing/blank titles to the same ordinal default. Add a controlled \`Step title\` input in \`QueryStepEditor\` without changing preview-cache cleanup dependencies. Add \`stepLabel()\` in \`run.types.tsx\`, pass \`run.stepTitles\` to \`RunLog\`, and use the helper for run result items, live event messages, and indexed history items/events.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run src/features/flows/FlowEditor.test.tsx src/features/flows/QueryStepEditor.test.tsx src/features/run/RunDashboard.test.tsx src/features/run/RunLog.test.tsx src/features/history/RunDetail.test.tsx\`

Expected: PASS with editor defaults, blank normalization, title-based live/history labels, and legacy fallback.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add src/features/flows/flows.types.tsx src/features/flows/FlowEditor.tsx src/features/flows/FlowEditor.test.tsx src/features/flows/QueryStepEditor.tsx src/features/flows/QueryStepEditor.test.tsx src/features/run/run.types.tsx src/features/run/RunDashboard.tsx src/features/run/RunDashboard.test.tsx src/features/run/RunLog.tsx src/features/run/RunLog.test.tsx src/features/history/RunDetail.tsx src/features/history/RunDetail.test.tsx
git commit -m "feat: edit and display flow step titles"
\`\`\`

### Task 5: Update deletion copy and complete verification

**Files:**
- Modify: \`src/features/connections/ConnectionList.tsx\`, \`src/features/connections/ConnectionList.test.tsx\`

**Interfaces:**
- Produces: the exact Korean \`CONNECTION_REFERENCED\` message requested by the user.

- [ ] **Step 1: Write the failing copy test**

\`\`\`tsx
expect(await screen.findByRole("status")).toHaveTextContent("flow에서 사용중이라 삭제할 수 없습니다.");
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run src/features/connections/ConnectionList.test.tsx\`

Expected: FAIL because the English message is still rendered.

- [ ] **Step 3: Write minimal implementation**

Replace only the \`CONNECTION_REFERENCED\` branch string in \`ConnectionList.tsx\`. Do not alter confirmation, code detection, or generic errors.

- [ ] **Step 4: Run focused and required verification**

Run:

\`\`\`powershell
pnpm vitest run src/features/connections/ConnectionList.test.tsx
pnpm vitest run electron/ipc/architecture.test.ts
pnpm test
pnpm lint
pnpm build
pnpm package
\`\`\`

Expected: all checks pass. If packaging is blocked by a Windows file lock, capture the locked path and retry guidance; do not report packaging as passed.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add src/features/connections/ConnectionList.tsx src/features/connections/ConnectionList.test.tsx
git commit -m "fix: clarify protected connection deletion"
\`\`\`

## Self-review

- Spec coverage: Task 1 covers title defaults, blank normalization, legacy flows, persistence, and import/export. Task 2 covers safe run/history title snapshots and typed IPC. Task 3 covers both renderer preflight and recovery sessions. Task 4 covers editor, live results/log, and history labels. Task 5 covers the exact deletion message and all required verification.
- Placeholder scan: no \`TODO\`, \`TBD\`, or generic test instructions remain; each test task includes expected behavior and a command.
- Type consistency: \`QueryStep.title\`, \`RunDto.stepTitles\`, \`HistoryRunDto.stepTitles\`, \`RunHistoryEntry.stepTitles\`, and \`stepLabel(stepTitles, index)\` use the same names throughout.

