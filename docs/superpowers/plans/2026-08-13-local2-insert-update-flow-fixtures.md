# Local2 Insert/Update Flow Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save five three-step, join-based Oracle test flows using only `INSERT` and `UPDATE` target statements in the local2 app database.

**Architecture:** Clone the existing `로컬2` connection row to a separate `로컬2-대상` ID without rendering or logging its plaintext credential. Save five flow rows and their ordered query steps in the same local SQLite database, then read back metadata and SQL text to validate connection separation, three-step order, source joins, and operation-to-keyword alignment.

**Tech Stack:** SQLite (`better-sqlite3`), Oracle SQL, Node.js.

## Global Constraints

- Target database: `C:\\Users\\kg\\AppData\\Roaming\\db-relay\\db-relay.sqlite`.
- Use existing `로컬2` as source and a distinct cloned `로컬2-대상` connection ID as target.
- Never print, persist outside the existing encrypted scope, or log passwords.
- Save exactly five flows, each with exactly three steps and `all_or_nothing` policy.
- Each source statement must join `SRC_USERS`, `SRC_USER_ADDRESSES`, and `SRC_USER_CONTACT_EXPORT`.
- `INSERT` target SQL corresponds to the insert operation; `UPDATE` target SQL corresponds to the update operation; no target SQL begins with `MERGE`.

---

### Task 1: Save and verify local2 flow fixtures

**Files:**
- Create: `data/local2-insert-update-flow-fixtures.json`
- Modify: local app SQLite `connection_profiles`, `flows`, `query_steps`

**Interfaces:**
- Consumes: source connection profile whose `display_name` is `로컬2` and the six Oracle fixture tables.
- Produces: one cloned target profile and flows `local2-insert-success`, `local2-update-success`, `local2-mixed-success`, `local2-insert-duplicate-failure`, and `local2-address-fk-failure`.

- [ ] **Step 1: Verify the source profile and fixture-table row ranges**

Query only the `id`, `display_name`, and `enabled` metadata for `로컬2`. Query Oracle fixture count metadata for keys `1001`–`1030`, `2001`–`2030`, and `3001`–`3030`.

Expected: exactly one enabled `로컬2` profile and 30 rows in each source table.

- [ ] **Step 2: Define five Flow fixtures**

Create `data/local2-insert-update-flow-fixtures.json` with five objects. Each object has a unique ID, Korean display name, `all_or_nothing` policy, and exactly three ordered steps. Every `selectSql` aliases a join across `SRC_USERS u`, `SRC_USER_ADDRESSES a`, and `SRC_USER_CONTACT_EXPORT e`; every target begins with either `INSERT INTO` or `UPDATE` according to the named operation.

The fixture categories are: all-insert success using IDs offset by `10000`; all-update success over `1001`–`1030`; update/insert/insert mixed success using address/export offsets `40000` and `50000`; a duplicate-key insert failure over existing user keys; and a user-address foreign-key update failure using user ID `999999` in its second step.

- [ ] **Step 3: Save a distinct target profile and all Flow rows transactionally**

In one SQLite immediate transaction, copy the `로컬2` connection row to a fixed target ID with display name `로컬2-대상`; retain credential fields in-database without selecting them into output. Upsert the five flow rows with `version = 1`, then replace each flow's three `query_steps` rows in positions 0–2.

Expected: five saved Flow records reference different source and target connection IDs.

- [ ] **Step 4: Read back and validate stored fixtures**

Read only IDs, display names, policies, step positions, and SQL strings. Assert five flow IDs, three steps per flow, source/target ID inequality, three source-table names and two `JOIN` tokens in each source SQL, and a target first keyword matching its fixture operation. Assert no target SQL begins with `MERGE`.

Expected: all five fixtures pass storage and SQL-shape validation; failure fixtures are stored but not executed.

- [ ] **Step 5: Commit the reusable fixture definition**

Run:

```powershell
git diff --check -- data/local2-insert-update-flow-fixtures.json
git add -- data/local2-insert-update-flow-fixtures.json
git commit -m "test: add local2 insert update flow fixtures"
```
