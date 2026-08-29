# User Management Merge Test Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and execute Oracle seed and merge scripts that demonstrate one update and two inserts for each user-management table.

**Architecture:** Seed scripts give source tables three synthetic rows and target tables only an older version of the first row. A separate merge script copies only the three reserved IDs from source to target using primary-key matches, leaving all other tables and rows untouched. Runtime checks abort before seeding if any reserved key already exists, then verify final target rows equal source rows.

**Tech Stack:** Oracle SQL, node-oracledb Thin mode, PowerShell, Git.

## Global Constraints

- Use only synthetic data; never store an Oracle URL, password, or raw connection details in repository files.
- The reserved test IDs are users `1001`–`1003`, addresses `2001`–`2003`, and exports `3001`–`3003`.
- Do not use `DELETE`, `TRUNCATE`, or `DROP`; a duplicate reserved key stops execution before any DML is applied.
- Each merge matches on its table primary key and must update row `1001`/`2001`/`3001` and insert the other two rows.

---

### Task 1: Add and run synthetic source-to-target merge data

**Files:**
- Create: `data/user-management-test-data.sql`
- Create: `data/user-management-merge-test.sql`
- Verify: the six existing Oracle tables in the configured disposable XE schema

**Interfaces:**
- Consumes: `SRC_USERS`, `SRC_USER_ADDRESSES`, `SRC_USER_CONTACT_EXPORT`, and their `TGT_` equivalents from `data/user-management-tables.sql`.
- Produces: three source rows and three target rows per table, where all target rows equal their corresponding source rows after `MERGE`.

- [ ] **Step 1: Run a precondition query that must find no reserved rows**

Run an Oracle query against all six tables for the reserved IDs. Fail before running any DML if any count is nonzero.

```sql
SELECT
  (SELECT COUNT(*) FROM SRC_USERS WHERE USER_ID BETWEEN 1001 AND 1003) AS SRC_USERS_COUNT,
  (SELECT COUNT(*) FROM SRC_USER_ADDRESSES WHERE ADDRESS_ID BETWEEN 2001 AND 2003) AS SRC_ADDRESSES_COUNT,
  (SELECT COUNT(*) FROM SRC_USER_CONTACT_EXPORT WHERE CONTACT_EXPORT_ID BETWEEN 3001 AND 3003) AS SRC_EXPORTS_COUNT,
  (SELECT COUNT(*) FROM TGT_USERS WHERE USER_ID BETWEEN 1001 AND 1003) AS TGT_USERS_COUNT,
  (SELECT COUNT(*) FROM TGT_USER_ADDRESSES WHERE ADDRESS_ID BETWEEN 2001 AND 2003) AS TGT_ADDRESSES_COUNT,
  (SELECT COUNT(*) FROM TGT_USER_CONTACT_EXPORT WHERE CONTACT_EXPORT_ID BETWEEN 3001 AND 3003) AS TGT_EXPORTS_COUNT
FROM DUAL;
```

Expected: all six counts are `0`.

- [ ] **Step 2: Add the seed script**

Create `data/user-management-test-data.sql` with six `INSERT ALL` statements: one each for the source and target user, address, and export tables. Seed source rows with IDs `1001`/`1002`/`1003`, `2001`/`2002`/`2003`, and `3001`/`3002`/`3003`. Seed target only with the `1001`, `2001`, and `3001` rows, using deliberately older `DISPLAY_NAME`, `EMAIL`, `USER_STATUS`, `CITY`, and `POSTAL_CODE` values.

Use these source user values:

```sql
1001, 'han.seojun', 'Han Seojun', 'han.seojun@example.test', 'ACTIVE'
1002, 'kim.minjae', 'Kim Minjae', 'kim.minjae@example.test', 'ACTIVE'
1003, 'lee.yuna', 'Lee Yuna', 'lee.yuna@example.test', 'SUSPENDED'
```

Use source addresses `2001`/`2002`/`2003` for users `1001`/`1002`/`1003`; use cities `Seoul`, `Busan`, and `Incheon` respectively. Copy each source user and address key plus `LOGIN_ID`, `EMAIL`, `ADDRESS_TYPE`, `CITY`, and `POSTAL_CODE` into the matching source export row. The target seed consists only of user `1001` with `DISPLAY_NAME = 'Han Seojun (Old)'`, `EMAIL = 'han.seojun.old@example.test'`, and `USER_STATUS = 'INACTIVE'`; address `2001` with `CITY = 'Old Seoul'` and `POSTAL_CODE = '00000'`; and export `3001` with the matching old email/city/postal code.

- [ ] **Step 3: Execute the seed script and verify the intended pre-merge state**

Run the six statements through node-oracledb in source-parent, source-child, source-export, target-parent, target-child, target-export order. Then run the Step 1 query again.

Expected: source counts are `3`, target counts are `1`; the target values for IDs `1001`, `2001`, and `3001` differ from source.

- [ ] **Step 4: Add the merge script**

Create `data/user-management-merge-test.sql` with these three primary-key merges, each restricted to its reserved ID range:

```sql
MERGE INTO TGT_USERS target
USING (
  SELECT USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT
  FROM SRC_USERS
  WHERE USER_ID BETWEEN 1001 AND 1003
) source
ON (target.USER_ID = source.USER_ID)
WHEN MATCHED THEN UPDATE SET
  target.LOGIN_ID = source.LOGIN_ID,
  target.DISPLAY_NAME = source.DISPLAY_NAME,
  target.EMAIL = source.EMAIL,
  target.USER_STATUS = source.USER_STATUS,
  target.REGISTERED_AT = source.REGISTERED_AT
WHEN NOT MATCHED THEN INSERT (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT)
VALUES (source.USER_ID, source.LOGIN_ID, source.DISPLAY_NAME, source.EMAIL, source.USER_STATUS, source.REGISTERED_AT);
```

Create equivalent `MERGE` statements for addresses keyed on `ADDRESS_ID` and exports keyed on `CONTACT_EXPORT_ID`, copying every non-key column from their `SRC_` table to the matching `TGT_` table.

- [ ] **Step 5: Execute the merge script and verify final values**

Execute the three `MERGE` statements through node-oracledb. Query target rows for the reserved IDs, asserting three target rows per table and equality with source for all merged columns.

Expected: each merge affects three rows; target IDs `1001`/`2001`/`3001` hold current source values and the two absent IDs are inserted.

- [ ] **Step 6: Review SQL boundaries and commit**

Run:

```powershell
rg -n -i '^\s*(DELETE|TRUNCATE|DROP)\b' data/user-management-test-data.sql data/user-management-merge-test.sql
git diff --check -- data/user-management-test-data.sql data/user-management-merge-test.sql
```

Expected: `rg` returns no matches and Git reports no whitespace errors.

Then commit:

```powershell
git add -- data/user-management-test-data.sql data/user-management-merge-test.sql
git commit -m "test: add user management merge data"
```
