# Generic Edit-Flow Step Restore Design

## Goal

Make Edit Flow step restoration independent of a hard-coded `USER_ID` key. Restore direct inserts by Oracle `ROWID`, and restore updates and upserts by safely extracting simple equality keys from the Target SQL. A disabled restore control must explain why it cannot run.

## Supported Target SQL

The restorable SQL parser accepts only a single target table and identifiers that are ordinary Oracle identifiers or double-quoted identifiers. The parser owns every identifier interpolated into a generated snapshot or restore statement.

- Insert: `INSERT INTO table (columns) VALUES (:binds)` with one bind per column, no existing `RETURNING` clause.
- Update: `UPDATE table SET column = :bind ... WHERE key = :key [AND ...]`.
- Upsert: `MERGE INTO table target USING (SELECT :bind column ... FROM dual) source ON (target.key = source.key [AND ...]) ...`.

Each supported equality term connects one target key column to one Source bind. Terms may use an optional target qualifier. `OR`, functions, operators other than `=`, literals, extra predicates, joins, subqueries, and unsupported `RETURNING` clauses make the statement non-restorable. They do not prevent Run.

## Snapshot and Restore Flow

1. At Run start, discard that step's old restore cache.
2. For Update and Upsert, query the target table before DML using extracted equality terms. Capture target `ROWID`, key columns, and columns that DML can change.
3. For Insert, execute a derived copy of the validated Insert SQL with `RETURNING ROWID INTO :DBR_RESTORE_ROWID`; retain only returned rowids.
4. Execute Update or Upsert normally, then capture the post-DML rows with the same extracted equality terms.
5. Build cache actions from before/after snapshots: delete inserted rowids; update existing rowids to prior values. Expected post-run values protect against overwriting later external edits.
6. Commit then retain only cache actions in main-process memory. Source rows and bind values are never persisted, logged, returned over IPC, or saved to history.

## Availability and User Feedback

`run_flow_step` returns an optional `restoreId` plus a safe `restoreAvailability` enum. The renderer keeps the latest availability per editor step.

- `ready`: a successful Run created an in-memory restore cache.
- `not_run`: no successful Run exists for this editor step.
- `target_sql_not_restorable`: the most recent successful Run used Target SQL outside the supported parser grammar; this includes arbitrary Target SQL changes, `OR`, and unsupported predicates.
- `run_failed`: the latest Run failed; no restore cache exists.
- `cache_missing`: the main-process cache was cleared (for example app restart) before Restore.
- `busy`: Run or Restore is in progress.

The Restore control uses `aria-disabled` instead of native `disabled` so clicking it cannot run a restore but displays a Korean explanation in the step's existing lower status/error area. Editing Source or Target SQL retains a cache from the previous Run until a new Run begins. Saving, unmounting, and app restart clear cache according to the established transient-cache rules; a later successful compatible Run sets `ready` again.

## Errors and Transactions

Parser incompatibility produces availability, not an execution error. `RETURNING ROWID` driver or database errors, pre/post snapshot failures, target DML failures, and restore conflicts follow existing safe connector error handling and rollback behavior. A failed Restore keeps its cache for retry unless the cache is genuinely unavailable.

## Verification

Unit tests cover key parsing, quoted/Korean identifiers, composite `AND` keys, rejection of `OR`, Insert returning-rowid handling, cache actions, and disabled-reason UI. Oracle Local2 integration tests create two persisted flows and verify Update (non-`USER_ID` key), Insert, and Upsert Run → Restore without persisting source rows or credentials.
