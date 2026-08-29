# React + Electron Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the current DB Relay functionality and UI as a Windows React + Electron application using `oracledb@^6.2.0` instead of Tauri/Rust.

**Architecture:** Keep the existing React renderer and typed command contract. Replace Tauri invocation with a context-isolated Electron preload bridge; move the existing Rust domain, application, persistence, and Oracle connector responsibilities into TypeScript modules in Electron's main process. All database access remains in the main process.

**Tech Stack:** React 19, TypeScript, Vite, Electron, electron-builder, `@electron/rebuild`, `oracledb@^6.2.0`, `better-sqlite3`, Vitest, React Testing Library, pnpm.

## Global Constraints

- Use `"oracledb": "^6.2.0"` for all production Oracle connectivity.
- Preserve existing React UI, routes, CSS, labels, command names, command DTO shapes, and run behavior.
- Set Electron `contextIsolation: true` and `nodeIntegration: false`; preload exposes only the named command allowlist.
- Renderer code must not import Node, Electron main, `oracledb`, SQLite, or credential implementation modules.
- Keep the current plaintext-password storage and same-length `passwordMask` display behavior; never return raw passwords over IPC.
- Never persist or return source rows, bind values, or raw passwords in run history or safe error DTOs.
- Preserve the current SID-based Oracle profile behavior with a descriptor-based `connectString`.
- Remove Tauri/Rust source, dependencies, scripts, CI steps, and active operational-documentation references before final verification. Preserve `docs/superpowers/**` and `docs/exec-plans/completed/**` as historical records.

---

### Task 1: Adopt the approved current implementation as the migration baseline

**Files:**
- Modify: the 21 tracked files reported by `git -C ../db-editor diff --name-only`
- Create: `src/features/flows/FlowLibrary.test.tsx`, `src/features/flows/QueryStepEditor.test.tsx`, `src/features/flows/sqlGeneration.ts`, `src/features/flows/sqlGeneration.test.ts`
- Do not copy: `.cargo-target-task3/`

**Interfaces:**
- Consumes: user-approved uncommitted changes in `feature/db-relay`.
- Produces: the latest UI, tests, domain fixes, and styles as the exact behavior to preserve during the runtime migration.

- [ ] **Step 1: Record the approved source change set**

Run: `git -C ../db-editor diff --name-status` and `git -C ../db-editor status --short`.

Expected: only the listed tracked source/test/style changes plus the four listed flow files are candidates; the Cargo target directory is excluded.

- [ ] **Step 2: Apply the approved source changes to this worktree**

Use `apply_patch` patches generated from the source worktree for every listed text file. Preserve each file's exact content; do not copy build artifacts or `.git` data.

- [ ] **Step 3: Verify the imported behavior is present**

Run:

```powershell
pnpm vitest run src/features/connections/ConnectionForm.test.tsx src/features/flows/FlowLibrary.test.tsx src/features/flows/QueryStepEditor.test.tsx src/features/flows/sqlGeneration.test.ts
```

Expected: the imported tests execute from this worktree; any pre-existing lint failure is recorded before the Electron changes begin.

- [ ] **Step 4: Commit the baseline adoption**

```powershell
git add src src-tauri docs
git commit -m "chore: adopt current DB Relay baseline"
```

### Task 2: Establish Electron/Vite build and package configuration

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `tsconfig.json`, `README.md`, `.gitignore`
- Create: `electron/main.ts`, `electron/preload.ts`, `electron-builder.yml`
- Test: `electron/preload.test.ts`

**Interfaces:**
- Consumes: existing Vite renderer build.
- Produces: Electron dev, build, and Windows package commands plus a preload bridge shell.

- [ ] **Step 1: Write a failing preload allowlist test**

```ts
import { describe, expect, it } from "vitest";
import { isAllowedCommand } from "./preload";

it("accepts only DB Relay command names", () => {
  expect(isAllowedCommand("list_connections")).toBe(true);
  expect(isAllowedCommand("execute_arbitrary_sql")).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify red**

Run: `pnpm vitest run electron/preload.test.ts`

Expected: FAIL because `electron/preload.ts` does not exist.

- [ ] **Step 3: Add Electron dependencies and scripts**

Add production dependencies `better-sqlite3` and `oracledb` with the exact value `^6.2.0`. Add dev dependencies `electron`, `electron-builder`, `@electron/rebuild`, `vite-plugin-electron`, and Node/Electron type definitions. Configure `vite-plugin-electron/simple` in the existing Vite config with `electron/main.ts` and `electron/preload.ts` as its two entries. Replace `tauri` scripts with:

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "package": "pnpm build && electron-builder --win",
  "rebuild:native": "electron-rebuild -f -w better-sqlite3 -w oracledb"
}
```

Set `package.json.main` to `dist-electron/main.js`. Configure electron-builder to package `dist/**` and `dist-electron/**`, unpack `node_modules/oracledb/**` and `node_modules/better-sqlite3/**` from ASAR, and create a Windows NSIS installer. Extend `tsconfig.json` to include `electron/**/*.ts` and Node types.

- [ ] **Step 4: Implement the minimum secure Electron shell**

```ts
const window = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: join(__dirname, "preload.js"),
  },
});
```

Define `isAllowedCommand()` from a `const` command list and expose only `dbRelay.invoke(command, request)` via `contextBridge`.

- [ ] **Step 5: Run the test to verify green and build the shell**

Run:

```powershell
pnpm vitest run electron/preload.test.ts
pnpm build
```

Expected: allowlist test passes and renderer/main/preload TypeScript compilation completes.

- [ ] **Step 6: Commit**

```powershell
git add package.json pnpm-lock.yaml vite.config.ts tsconfig.json electron electron-builder.yml README.md .gitignore
git commit -m "build: add Electron desktop shell"
```

### Task 3: Preserve the renderer command facade through preload IPC

**Files:**
- Modify: `src/lib/tauri.ts`, `src/test/setup.ts`
- Create: `src/types/electron-api.d.ts`
- Test: `src/lib/tauri.test.ts`

**Interfaces:**
- Consumes: `window.dbRelay.invoke(command, request)`.
- Produces: existing `invokeCommand<TCommand>()` type signature and response map unchanged for all React features.

- [ ] **Step 1: Write a failing facade forwarding test**

```ts
it("forwards an allowed typed command to the preload bridge", async () => {
  window.dbRelay = { invoke: vi.fn().mockResolvedValue([]) };
  await expect(invokeCommand("list_connections")).resolves.toEqual([]);
  expect(window.dbRelay.invoke).toHaveBeenCalledWith("list_connections", undefined);
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run src/lib/tauri.test.ts`

Expected: FAIL because `window.dbRelay` is not defined in renderer typings.

- [ ] **Step 3: Define the preload API and replace Tauri invocation**

```ts
export function invokeCommand<TCommand extends keyof CommandRequestMap>(
  command: TCommand,
  ...[request]: CommandRequestMap[TCommand] extends undefined ? [] : [CommandRequestMap[TCommand]]
) {
  return window.dbRelay.invoke(command, request) as Promise<CommandResponseMap[TCommand]>;
}
```

Update only test setup mocks; do not change feature component call sites or DTO names.

- [ ] **Step 4: Verify renderer tests remain green**

Run: `pnpm test`

Expected: all existing renderer tests pass through the preload mock, without `@tauri-apps/api` imports.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/tauri.ts src/lib/tauri.test.ts src/test/setup.ts src/types/electron-api.d.ts
git commit -m "feat: route renderer commands through Electron IPC"
```

### Task 4: Port pure domain rules and their existing scenarios to TypeScript

**Files:**
- Create: `electron/domain/{models,mapping,sqlValidation,runState,errorMasking}.ts`
- Create: `electron/domain/{mapping,sqlValidation,runState,errorMasking}.test.ts`
- Reference: `src-tauri/src/domain/{model,mapping,run_state,error_masking}.rs`, `src-tauri/tests/{mapping,run_state}.rs`

**Interfaces:**
- Produces: `extractNamedBinds(sql)`, `mapRow(row, bindNames)`, `validateSourceStatement(sql)`, `validateTargetStatement(kind, sql)`, `RunState`, and `maskSensitiveText(value, secrets)`.
- Consumes: the existing DTO values and Oracle connector adapter.

- [ ] **Step 1: Write the mapping tests before implementation**

```ts
it("maps Oracle binds to source columns without case sensitivity", () => {
  expect(mapRow({ CUSTOMER_ID: 7, display_name: "Ada" }, ["customer_id", "DISPLAY_NAME"]))
    .toEqual({ customer_id: 7, DISPLAY_NAME: "Ada" });
});

it("rejects a bind missing from the source row", () => {
  expect(() => mapRow({ CUSTOMER_ID: 7 }, ["DISPLAY_NAME"]))
    .toThrow("missing source column");
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/domain/mapping.test.ts`

Expected: FAIL because the domain module is missing.

- [ ] **Step 3: Implement mapping and lexical SQL validation**

Port the existing comment/string-aware bind parser and the existing `SELECT`/`WITH` source and Oracle `MERGE` target restrictions exactly. Preserve case-insensitive mapping, duplicate source-column checks, and numeric-bind rejection.

- [ ] **Step 4: Add and run state/error tests**

Port each scenario from `src-tauri/tests/run_state.rs`, including invalid transitions, awaiting recovery, commit pending, rollback, and in-doubt statuses. Add masking cases proving passwords and connection-string passwords become `***`.

Run: `pnpm vitest run electron/domain`

Expected: all pure-domain scenarios pass.

- [ ] **Step 5: Commit**

```powershell
git add electron/domain
git commit -m "feat: port migration domain rules to TypeScript"
```

### Task 5: Port SQLite persistence, connection settings, and flow services

**Files:**
- Create: `electron/infrastructure/sqliteRepository.ts`, `electron/infrastructure/sqliteRepository.test.ts`
- Create: `electron/application/{settingsService,flowService}.ts`
- Create: `electron/application/{settingsService,flowService}.test.ts`
- Reference: `src-tauri/src/{infrastructure/sqlite.rs,application/settings_service.rs,application/flow_service.rs}` and `src-tauri/tests/sqlite.rs`

**Interfaces:**
- Produces: `ConnectionRepository`, `FlowRepository`, `HistoryRepository`, `SettingsService`, and `FlowService`.
- Consumes: domain DTOs and `better-sqlite3` in the main process only.

- [ ] **Step 1: Write failing SQLite migration and mask tests**

```ts
it("migrates legacy connection data without losing a keyring profile", () => {
  const repository = openLegacyDatabase();
  expect(repository.loadConnection("legacy")?.credentialStorage).toBe("keyring");
});

it("projects a plaintext password as a same-length mask", () => {
  expect(passwordMask({ plaintextPassword: "secret123", credentialStorage: "plaintext" }))
    .toBe("*********");
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/infrastructure/sqliteRepository.test.ts electron/application/settingsService.test.ts`

Expected: FAIL because the repository and service do not exist.

- [ ] **Step 3: Implement schema-compatible repositories**

Port table names, columns, schema migrations, versioning, run-history safe projection, and connection/flow ordering from `sqlite.rs`. Store current plaintext profiles and retain legacy keyring profile compatibility. Never select raw password fields into renderer response DTOs.

- [ ] **Step 4: Implement settings and flow validation**

Implement required connection fields, SID validation, enabled-state changes, test-connection delegation, flow duplication/version increments, distinct source/target checks, and query-step validation from the existing services.

- [ ] **Step 5: Verify green**

Run: `pnpm vitest run electron/infrastructure/sqliteRepository.test.ts electron/application/settingsService.test.ts electron/application/flowService.test.ts`

Expected: persistence and service tests pass, including mask-only command projections.

- [ ] **Step 6: Commit**

```powershell
git add electron/infrastructure electron/application/settingsService.ts electron/application/flowService.ts
git commit -m "feat: add Electron persistence and settings services"
```

### Task 6: Implement the `oracledb@^6.2.0` connector contract

**Files:**
- Create: `electron/connectors/{databaseConnector,oracleConnector,registry}.ts`
- Create: `electron/connectors/oracleConnector.test.ts`
- Reference: `src-tauri/src/{application/ports.rs,connectors/oracle.rs}`, `src-tauri/tests/oracle_contract.rs`

**Interfaces:**
- Produces: `DatabaseConnectorFactory.open(profile, secret)`, `DatabaseSession.query/begin/executeNamed/commit/rollback/close`, and `ConnectorError`.
- Consumes: `oracledb@^6.2.0` only from `oracleConnector.ts`.

- [ ] **Step 1: Write a failing SID descriptor and batch-bind test**

```ts
it("opens an Oracle SID profile through a SID connect descriptor", async () => {
  await connector.open({ host: "db.example", port: 1521, sid: "XE", username: "relay" }, "secret");
  expect(driver.getConnection).toHaveBeenCalledWith(expect.objectContaining({
    connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example)(PORT=1521))(CONNECT_DATA=(SID=XE)))",
  }));
});

it("executes named batches with executeMany", async () => {
  await session.executeNamed("MERGE INTO t USING :ID", [{ ID: 7 }]);
  expect(driver.executeMany).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

Expected: FAIL because the connector is missing.

- [ ] **Step 3: Implement the adapter behind the contract**

Use `oracledb.getConnection({ user, password, connectString })` and a thin-mode SID descriptor. Query with `outFormat: oracledb.OUT_FORMAT_OBJECT`; convert supported scalar/date/buffer values without stringifying unsupported values. Use `executeMany(sql, rows, { autoCommit: false, bindDefs })` for target rows, and `commit()`/`rollback()` for transaction control. Normalize Oracle errors to masked `ORA-xxxxx` values and always close connections.

- [ ] **Step 4: Verify contract behavior**

Run: `pnpm vitest run electron/connectors/oracleConnector.test.ts`

Expected: SID configuration, named binds, error-code preservation, masking, rollback, and close-on-error tests pass.

- [ ] **Step 5: Add an opt-in integration test**

Create `electron/connectors/oracle.integration.test.ts`. Skip unless `DB_RELAY_ORACLE_TEST_URL` exists; otherwise connect to the disposable fixture, run the existing named-MERGE/rollback scenario, and clean up test tables.

- [ ] **Step 6: Commit**

```powershell
git add electron/connectors
git commit -m "feat: add node-oracledb Oracle connector"
```

### Task 7: Port migration execution, recovery, and safe history

**Files:**
- Create: `electron/application/{migrationRunner,historyService}.ts`
- Create: `electron/application/{migrationRunner,historyService}.test.ts`
- Reference: `src-tauri/src/application/migration_runner.rs`, `src-tauri/tests/migration_runner.rs`

**Interfaces:**
- Produces: `startRun(flowId): Promise<RunDto>`, `recoverRun(request): Promise<RunDto>`, and `listRunHistory(): Promise<HistoryRunDto[]>`.
- Consumes: repository interfaces, credential resolver, and `DatabaseConnectorFactory`.

- [ ] **Step 1: Write a failing all-or-nothing rollback test**

```ts
it("rolls back the target when the second all-or-nothing step fails", async () => {
  const result = await runner.startRun("two-step-flow");
  expect(result.status).toBe("rolled_back");
  expect(target.rollback).toHaveBeenCalledOnce();
  expect(target.commit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: FAIL because `MigrationRunner` is missing.

- [ ] **Step 3: Implement preflight and both transaction policies**

Port the existing flow/profile validation order, source/target connector opening, preflight mapping before target `begin`, all-or-nothing rollback behavior, per-step commit behavior, and persisted safe run snapshots. Ensure source and target connections are closed in `finally` blocks.

- [ ] **Step 4: Write and run recovery tests before recovery implementation**

```ts
it("retries only the failed step after edit-and-retry", async () => {
  const recovered = await runner.recoverRun({ type: "edit_and_retry", runId: "run-1", stepId: "step-2", selectSql: "SELECT 1 ID FROM dual", upsertSql: "MERGE INTO t USING :ID" });
  expect(recovered.status).toBe("completed");
  expect(target.executedSteps).toEqual([1]);
});
```

Run: `pnpm vitest run electron/application/migrationRunner.test.ts`

Expected: recovery test fails until `edit_and_retry`, `skip_and_continue`, and `stop` each have one explicit transition.

- [ ] **Step 5: Implement recovery and history projection**

Port all valid and invalid recovery transitions, flow-version history behavior, and safe history DTO projection. Assert no history serialization includes passwords, raw SQL, bind values, source rows, or credential references.

- [ ] **Step 6: Verify green**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts electron/application/historyService.test.ts`

Expected: every existing migration-runner scenario has an equivalent passing TypeScript test.

- [ ] **Step 7: Commit**

```powershell
git add electron/application/migrationRunner.ts electron/application/historyService.ts electron/application/migrationRunner.test.ts electron/application/historyService.test.ts
git commit -m "feat: port migration execution and recovery"
```

### Task 8: Register typed IPC handlers and protect the process boundary

**Files:**
- Create: `electron/ipc/{handlers,commands}.ts`, `electron/ipc/handlers.test.ts`, `electron/ipc/architecture.test.ts`
- Modify: `electron/main.ts`, `electron/preload.ts`

**Interfaces:**
- Consumes: application services from Tasks 5 and 7.
- Produces: all current command names with their unchanged request and response DTOs.

- [ ] **Step 1: Write a failing command boundary test**

```ts
it("registers list_connections and rejects arbitrary SQL", async () => {
  expect(await invoke("list_connections")).toEqual([]);
  await expect(invoke("execute_arbitrary_sql", { sql: "select 1" })).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
});

it("does not serialize a plaintext password in a connection response", async () => {
  await expect(invoke("list_connections")).resolves.toEqual([
    expect.objectContaining({ passwordMask: "******" }),
  ]);
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/ipc/handlers.test.ts`

Expected: FAIL because handlers are not registered.

- [ ] **Step 3: Implement typed handlers and DTO errors**

Map each existing command name directly to a service method. Validate the command allowlist in both preload and main. Convert errors into the existing `{ title, detail, code, runId?, stepId? }` shape after secret masking.

- [ ] **Step 4: Add static architecture tests**

Assert `rg`-equivalent import checks in TypeScript: no `oracledb`, `better-sqlite3`, `electron/main`, or Node builtins in `src/`; no `execute_arbitrary_sql`; and no renderer password projection beyond `passwordMask`.

- [ ] **Step 5: Verify green**

Run: `pnpm vitest run electron/ipc`

Expected: command allowlist, DTO privacy, and static boundary tests pass.

- [ ] **Step 6: Commit**

```powershell
git add electron/main.ts electron/preload.ts electron/ipc
git commit -m "feat: expose DB Relay services through secure IPC"
```

### Task 9: Remove Tauri/Rust and align docs, scripts, and CI

**Files:**
- Delete: `src-tauri/`
- Modify: `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `.github/workflows/*`, `docs/product-specs/db-relay.md`, `docs/design-docs/connectors.md`
- Test: `electron/ipc/architecture.test.ts`

**Interfaces:**
- Produces: Electron-only repository guidance and CI checks.

- [ ] **Step 1: Write a failing absence test**

```ts
it("contains no Tauri or Rust runtime references in active files", () => {
  expect(activeRepositoryText()).not.toMatch(/@tauri-apps|src-tauri|cargo test|pnpm tauri/i);
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/ipc/architecture.test.ts`

Expected: FAIL while Tauri/Rust files and command references exist.

- [ ] **Step 3: Remove and rewrite the runtime documentation**

Delete the entire verified `src-tauri` directory. Update every active repository guide to state Electron main/preload/renderer boundaries, `oracledb@^6.2.0`, the current plaintext mask behavior, the Oracle integration-test environment variable, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`.

- [ ] **Step 4: Verify green**

Run:

```powershell
pnpm vitest run electron/ipc/architecture.test.ts
rg -n "@tauri-apps|src-tauri|cargo test|pnpm tauri" --glob '!docs/superpowers/**' --glob '!docs/exec-plans/completed/**' .
```

Expected: the test passes and ripgrep reports no active-file references. Historical design and completed-plan references are excluded deliberately.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "refactor: remove Tauri Rust runtime"
```

### Task 10: Run full Windows release verification

**Files:**
- Create: `docs/test/reports/2026-08-08-react-electron-migration.md`

**Interfaces:**
- Consumes: complete Electron-only application.
- Produces: recorded verification results and installer artifact locations.

- [ ] **Step 1: Run static and unit verification**

Run:

```powershell
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit 0 with no TypeScript errors; existing React UI tests and ported Node tests pass.

- [ ] **Step 2: Rebuild native modules and package Windows installer**

Run:

```powershell
pnpm rebuild:native
pnpm package
```

Expected: Electron-native `oracledb` and SQLite modules rebuild successfully, and electron-builder emits the Windows NSIS installer.

- [ ] **Step 3: Run optional Oracle integration test when configured**

Run: `pnpm vitest run electron/connectors/oracle.integration.test.ts`

Expected: skipped with an explicit message when `DB_RELAY_ORACLE_TEST_URL` is absent; otherwise passes the disposable named-MERGE/rollback fixture and cleanup.

- [ ] **Step 4: Record the results**

```markdown
# React + Electron Migration Verification

- Commit:
- `pnpm lint`:
- `pnpm test`:
- `pnpm build`:
- `pnpm rebuild:native`:
- `pnpm package`:
- Oracle integration test: passed / skipped (reason)
- NSIS artifact:
- Remaining release risk:
```

- [ ] **Step 5: Commit**

```powershell
git add docs/test/reports/2026-08-08-react-electron-migration.md
git commit -m "docs: record Electron migration verification"
```
