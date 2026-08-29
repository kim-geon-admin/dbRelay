# Flow step titles and same-connection execution design

**Date:** 2026-08-28

## Goals

1. Show the Korean message `flow에서 사용중이라 삭제할 수 없습니다.` when a connection that is referenced by a flow is deleted.
2. Permit a flow to use the same enabled connection as both its source and target.
3. Give every query step a persisted, user-editable title and use that title in run progress and run history.

## Data model and compatibility

`QueryStep` gains a non-empty `title` field. The editor initializes newly added steps as `Step 1`, `Step 2`, and so on, based on the visible step position. A blank title is normalized to that same positional default before a flow is saved.

Existing saved flows are compatible without requiring a manual migration: loading, editing, or running a legacy step that has no title resolves its display and saved value to `Step {position}`. When such a flow is next saved, the normalized titles are persisted. This ensures users never see an empty title.

The SQLite query-step persistence and the typed IPC/renderer DTOs carry the title only. SQL text, bind values, passwords, and source rows remain outside history and renderer logging surfaces.

## Execution and history data flow

At run creation, the application captures the resolved ordered step-title list in the run record together with the existing safe flow metadata. Current run DTOs and history DTOs expose that list. Renderer labels resolve a step event/result index through the captured list and fall back to `Step {index}` for legacy run records.

Capturing a title snapshot makes history stable: renaming a step later, deleting the flow, or reordering its steps never changes labels already recorded for a completed or failed run.

## Same-connection execution

The run-dashboard preflight no longer rejects a flow just because source and target connection IDs match. The migration runner's recoverable-session path also opens independent bound source and target sessions for that case. Existing connection validation, enabled-state validation, SQL validation, and transaction/error handling remain unchanged.

## UI behavior

- Each step editor includes a `Step title` text field.
- New and blank titles display the ordinal default before save.
- Run results, live log entries, and history detail use the captured title instead of `Step 1`, `Step 2` generated solely from an index.
- The connection-reference deletion message is replaced exactly with the requested Korean wording.

## Test strategy

- Unit and component tests cover initial step titles, blank-title normalization, persistence round trips, and legacy flows without titles.
- Run/history tests cover title snapshots and title display, including fallback for legacy history.
- Run-dashboard and migration-runner tests cover same source/target connection execution.
- Connection deletion UI tests assert the revised message.
- Required project checks: `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm package`, plus `pnpm vitest run electron/ipc/architecture.test.ts`.
