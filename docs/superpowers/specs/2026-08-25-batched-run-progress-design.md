# Batched Run Progress Design

**Status:** Approved for planning  
**Date:** 2026-08-25

## Goal

Execute each migration query step in fixed 1,000-row target batches and show
live, safe progress in the Run dashboard. The feature does not add a cancel
action and does not change preview behavior.

## Scope

- Split every `start_run` and recovery target execution batch into chunks of
  1,000 rows.
- Emit an in-memory progress notification after each successfully executed
  chunk.
- Display the current step, processed/total rows, batch number, and a native
  progress bar while a run is active.
- Preserve the existing `all_or_nothing` and `commit_successes` semantics.
- Keep all source rows, bind values, credentials, and SQL out of progress
  notifications, IPC history, logs, and SQLite.

Out of scope:

- Cancellation, pause, or resume controls.
- Pagination, virtual rendering, or limiting rows in the preview dialog.
- Configurable batch sizes.
- Persisting progress in run history.
- Altering the one-step editor `run_flow_step` command.

## Chosen Architecture

### Execution

`MigrationRunner` owns a `RUN_BATCH_SIZE` constant of 1,000. It will route the
already validated `NamedRow[]` for a flow query step through a focused batch
executor. The executor calls `DatabaseSession.executeNamed` once per chunk,
sums the affected-row counts, and invokes an optional progress callback only
after that chunk succeeds.

The flow currently reads and maps a source result before target execution. This
change intentionally does not stream source queries, so it reduces target DML
request size but does not remove source-result or preview memory costs.

### Transaction semantics

For `all_or_nothing`, all chunks for every step run within the existing single
target transaction. The target commits only after every step and chunk has
succeeded. A chunk failure follows the existing rollback path; any reported
progress was execution progress and must not be described as committed data.

For `commit_successes`, all chunks for one query step run within that step's
existing transaction. The step commits only after its final chunk succeeds.
If any chunk fails, that step rolls back, moves to the existing recovery state,
and an edit-and-retry executes its replacement step using the same chunking.
Previously committed steps remain committed.

The final per-step `affected_rows` history value remains the total returned by
all of the step's chunks. No new run-history event type or SQLite column is
introduced.

### Progress transport

The application layer exposes a progress callback whose payload contains only:

```ts
type RunProgress = {
  runId: string;
  step: number;
  processedRows: number;
  totalRows: number;
  completedBatches: number;
  totalBatches: number;
};
```

`start_run` and recovery requests pass this callback from the trusted Electron
IPC handler. The handler sends a named, validated progress event only to the
same trusted renderer that initiated the run. The preload exposes a typed
subscribe/unsubscribe function for this fixed event name; it must not expose a
generic event subscription API. The renderer clears its local progress state
when the invoke call resolves or rejects and on component unmount.

Progress remains transient. It never enters `RunDto`, history DTOs, repository
state, SQLite, the run log, or generic error surfaces. Its schema contains
counts and indexes only, so it cannot disclose source rows, bind values,
credentials, or SQL.

### UI

While `RunDashboard` awaits `startRun` or `recoverRun`, it listens for progress
for that request's run ID. When a progress message arrives it shows an
accessible progress section directly below the run summary:

```text
실행 중 · 2단계
3,000 / 10,000건 처리됨 · 배치 3/10
[===========---------]
```

The native `<progress>` element uses `processedRows` and `totalRows`. The copy
uses “처리됨,” never “커밋 완료,” while execution is active. Existing final
step results and run log messages retain their committed wording. No cancel
control is displayed.

## Error Handling

- A failed chunk reports no progress for that chunk.
- The existing sanitized connector error and transaction recovery behavior is
  preserved. No row or bind context is added to it.
- If progress payload validation fails at a boundary, the event is discarded;
  the run's final invoke response remains authoritative.
- A closed renderer cannot receive a progress event. Its run may still finish
  according to current main-process behavior, and no listener is retained.

## Files and Tests

Expected production changes:

- `electron/application/migrationRunner.ts`: fixed-size chunk execution and
  callback propagation for start and recovery paths.
- `electron/ipc/commands.ts`, `electron/preload.ts`, `electron/ipc/handlers.ts`,
  and `electron/main.ts`: named typed progress event and trusted-sender wiring.
- `src/lib/desktop.ts`, `src/features/run/run.api.tsx`, `RunDashboard.tsx`, and
  `src/styles/global.css`: subscription, progress state, accessible display,
  and styling.

Tests will cover chunk boundaries (0, 1,000, 1,001, and multiple chunks),
progress counts, both transaction policies, partial-chunk failure and
edit-and-retry recovery, typed IPC projection/validation, renderer subscription
cleanup, and dashboard progress presentation. Boundary changes also require
`electron/ipc/architecture.test.ts` and the repository's complete verification
suite.
