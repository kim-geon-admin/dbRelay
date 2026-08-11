# Oracle workflow integration test design

**Status:** proposed for review  
**Date:** 2026-08-11

## Goal

Verify the real DB Relay workflow against a disposable Oracle fixture: register
connections, register a flow, run it, recover from failures, inspect run
history, and verify the target tables. This supplements unit tests and the
existing connector-only Oracle integration test.

## Test boundary

The application under test begins at the typed IPC command handler. Each test
uses real application services, a real `OracleConnector`, and a temporary
SQLite repository. It invokes only the typed commands:

- `save_connection`, `list_connections`, and `test_connection`
- `save_flow`
- `start_run` and `recover_run`
- `list_run_history`

The fixture harness may use an Oracle session directly for controlled DDL,
seeding, cleanup, and read-only result assertions. It must not expose a
generic-SQL capability through the app IPC or renderer.

## Isolation and safety

- Tests skip unless `DB_RELAY_ORACLE_TEST_URL` is explicitly supplied.
- The supplied Oracle account must be a dedicated disposable test account or
  schema. The tests create and drop tables.
- Table identifiers use a generated `DBR_WF_<process>_<nonce>` prefix; values
  are fixed test fixtures and never logged.
- A temporary SQLite file is used instead of the user's application database.
- `try`/`finally` cleanup drops every generated table and removes the temporary
  SQLite file.
- Test assertions must not print or serialize the Oracle URL, password, source
  rows, or bind values. Renderer-facing responses and persisted history are
  checked for the absence of sentinel secret and row values.

## Fixture schema

Create one source table and three target tables:

- `SRC_CUSTOMER`: two normal customer rows.
- `SRC_ORDER`: one row with a negative amount to deterministically violate the
  `ORDER_TARGET.amount > 0` check constraint.
- `SRC_AUDIT`: one normal audit row.
- `CUSTOMER_TARGET`, `ORDER_TARGET`, and `AUDIT_TARGET`: target tables with
  primary keys; `ORDER_TARGET` also has the positive-amount constraint.

Source and target use distinct saved connection IDs. They may refer to the
same disposable Oracle account because the tables are distinct.

## Workflow scenarios

| ID | Policy and action | Required database assertion | Required application assertion |
| --- | --- | --- | --- |
| WF-01 | Register source/target connections and a three-step flow | None | Connections list has only masks; saved flow round-trips through IPC. |
| WF-02 | `all_or_nothing`: all valid steps | All expected target rows are merged. | Run is `completed`; history has counts and no secret data. |
| WF-03 | `all_or_nothing`: fail second step | No target rows remain, including the first-step row. | Run is `rolled_back`; recovery is unavailable. |
| WF-04 | Preflight with a missing bind alias | No target table changes. | Run is `failed` before a target write. |
| WF-05 | `commit_successes`: fail second step | First-step row exists; failed and later-step rows do not. | Run awaits recovery. |
| WF-06 | After WF-05, skip and continue | First and third step rows exist; failed-step row does not. | Run completes; step is `skipped_by_user`. |
| WF-07 | After WF-05, stop | Only the first-step row exists. | Run is `stopped_by_user`; later step is `not_run`. |
| WF-08 | After WF-05, edit and retry | Revised second step and third step complete successfully. | Run completes and the flow version increases. |
| WF-09 | Change the flow or bound connection while paused | No additional target changes. | Recovery rejects with `RECOVERY_CONFIG_MISMATCH`. |
| WF-10 | Disabled connection | No Oracle work occurs. | Start rejects with `CONNECTION_DISABLED`. |

## Test structure

Create `electron/workflows/workflow.integration.test.ts` and keep fixture-only
utilities in `electron/workflows/workflowTestHarness.ts`. The harness owns
table-name generation, DDL/seed/teardown, temporary repository lifecycle,
typed command-handler construction, and direct Oracle result queries.

The existing `electron/connectors/oracle.integration.test.ts` remains a small
connector contract test. Workflow tests must not replace unit tests for
mapping, runner state transitions, IPC validation, or security projection.

## Verification

Without the Oracle environment variable, the new suite skips. With a dedicated
disposable Oracle endpoint, run:

```powershell
pnpm vitest run electron/workflows/workflow.integration.test.ts
pnpm vitest run electron/ipc/architecture.test.ts
pnpm test
pnpm lint
pnpm build
pnpm package
```
