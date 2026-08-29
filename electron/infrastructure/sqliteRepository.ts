import Database from "better-sqlite3";

import type {
  ConnectionProfile,
  CredentialStorage,
  Flow,
  QueryStep,
  RecoveryAction,
  RunErrorData,
  RunEvent,
  RunStateData,
  RunStatus,
  StepStatus,
} from "../domain/models";
import { RunError, RunState } from "../domain/runState";
import { safeConnectorDiagnostic } from "../domain/safeConnectorDiagnostic";
import type {
  BoundRecoveryApply,
  ConnectionRepository,
  FlowRepository,
  HistoryRepository,
  RunBinding,
  RunHistoryEntry,
} from "../application/ports";

export type {
  BoundRecoveryApply,
  ConnectionRepository,
  FlowRepository,
  HistoryRepository,
  RunBinding,
  RunHistoryEntry,
} from "../application/ports";

export class RepositoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

type ConnectionRow = {
  id: string;
  display_name: string;
  kind: string;
  host: string;
  port: number;
  service_name: string;
  username: string;
  credential_ref: string;
  credential_storage: string;
  plaintext_password: string | null;
  enabled: number;
  source_read_only: number;
};

type StoredRunBinding = {
  flow_id: string;
  flow_version: number;
  source_connection_id: string;
  source_signature: string;
  target_connection_id: string;
  target_signature: string;
};

type StoredRunEvent =
  | { type: "step_succeeded"; step: number; affected_rows: number }
  | {
    type: "step_failed";
    step: number;
    error_code: string;
    error_message: string;
    retryable: boolean;
  }
  | {
    type: "transaction_failed";
    error_code: string;
    error_message: string;
    retryable: boolean;
  }
  | { type: "recovery_applied"; step: number; action: RecoveryAction };

type StoredRun = {
  policy: RunStateData["policy"];
  status: RunStatus;
  steps: StepStatus[];
  events: StoredRunEvent[];
  flow_id?: string;
  flow_name?: string;
  source_db_name?: string;
  target_db_name?: string;
  flow_version?: number;
  step_titles?: string[];
  binding?: StoredRunBinding;
};

export class SqliteRepository implements ConnectionRepository, FlowRepository, HistoryRepository {
  readonly database: Database.Database;

  constructor(databaseOrPath: Database.Database | string) {
    this.database = typeof databaseOrPath === "string"
      ? new Database(databaseOrPath)
      : databaseOrPath;
    this.initialize();
  }

  static open(path: string): SqliteRepository {
    return new SqliteRepository(path);
  }

  static inMemory(): SqliteRepository {
    return new SqliteRepository(":memory:");
  }

  close(): void {
    this.database.close();
  }

  saveConnection(profile: ConnectionProfile): void {
    this.sqlite(() => {
      this.database.prepare(`
        INSERT INTO connection_profiles
          (id, display_name, kind, host, port, service_name, username,
           credential_ref, credential_storage, plaintext_password, enabled, source_read_only)
        VALUES
          (@id, @displayName, @kind, @host, @port, @sid, @username,
           @credentialRef, @credentialStorage, @plaintextPassword, @enabled, @sourceReadOnly)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          kind = excluded.kind,
          host = excluded.host,
          port = excluded.port,
          service_name = excluded.service_name,
          username = excluded.username,
          credential_ref = excluded.credential_ref,
          credential_storage = excluded.credential_storage,
          plaintext_password = excluded.plaintext_password,
          enabled = excluded.enabled,
          source_read_only = excluded.source_read_only
      `).run(connectionParameters(profile));
    });
  }

  updateConnection(profile: ConnectionProfile): void {
    if (this.loadConnection(profile.id) === undefined) {
      throw new RepositoryError("CONNECTION_NOT_FOUND", "connection not found");
    }
    this.saveConnection(profile);
  }

  loadConnection(connectionId: string): ConnectionProfile | undefined {
    return this.sqlite(() => {
      const row = this.database.prepare(`
        SELECT id, display_name, kind, host, port, service_name, username,
               credential_ref, credential_storage, plaintext_password, enabled,
               source_read_only
        FROM connection_profiles
        WHERE id = ?
      `).get(connectionId) as ConnectionRow | undefined;
      return row === undefined ? undefined : connectionFromRow(row);
    });
  }

  loadRunnableConnection(connectionId: string): ConnectionProfile | undefined {
    const profile = this.loadConnection(connectionId);
    if (profile !== undefined && !profile.enabled) {
      throw new RepositoryError("CONNECTION_DISABLED", "connection is disabled");
    }
    return profile;
  }

  listConnections(): ConnectionProfile[] {
    return this.sqlite(() => (this.database.prepare(`
      SELECT id, display_name, kind, host, port, service_name, username,
             credential_ref, credential_storage, plaintext_password, enabled,
             source_read_only
      FROM connection_profiles
      ORDER BY display_name, id
    `).all() as ConnectionRow[]).map(connectionFromRow));
  }

  disableConnection(connectionId: string): void {
    const result = this.sqlite(() => this.database.prepare(
      "UPDATE connection_profiles SET enabled = 0 WHERE id = ?",
    ).run(connectionId));
    if (result.changes === 0) {
      throw new RepositoryError("CONNECTION_NOT_FOUND", "connection not found");
    }
  }

  deleteConnection(connectionId: string): void {
    this.port(() => this.database.transaction(() => {
      const exists = this.database.prepare(
        "SELECT 1 FROM connection_profiles WHERE id = ?",
      ).get(connectionId) !== undefined;
      if (!exists) {
        throw new RepositoryError("CONNECTION_NOT_FOUND", "connection not found");
      }
      const referenced = this.database.prepare(`
        SELECT 1 FROM flows
        WHERE source_connection_id = ? OR target_connection_id = ?
        LIMIT 1
      `).get(connectionId, connectionId) !== undefined;
      if (referenced) {
        throw new RepositoryError(
          "CONNECTION_REFERENCED",
          "connection is referenced by a flow",
        );
      }
      this.database.prepare("DELETE FROM connection_profiles WHERE id = ?").run(connectionId);
    }).immediate());
  }

  saveFlow(flow: Flow): void {
    this.port(() => this.database.transaction(() => {
      const current = this.database.prepare(
        "SELECT version FROM flows WHERE id = ?",
      ).get(flow.id) as { version: number } | undefined;
      if (current !== undefined && current.version !== flow.version) {
        throw new RepositoryError("FLOW_VERSION_CONFLICT", "flow was changed by another save");
      }
      const nextVersion = current === undefined ? 1 : current.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw new RepositoryError("FLOW_VERSION_INVALID", "flow version cannot be advanced");
      }
      this.database.prepare(`
        INSERT INTO flows
          (id, name, source_connection_id, target_connection_id, transaction_policy, version)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          source_connection_id = excluded.source_connection_id,
          target_connection_id = excluded.target_connection_id,
          transaction_policy = excluded.transaction_policy,
          version = excluded.version
      `).run(
        flow.id,
        flow.name,
        flow.sourceConnectionId,
        flow.targetConnectionId,
        flow.transactionPolicy,
        nextVersion,
      );
      this.replaceFlowSteps(flow);
    })());
  }

  deleteFlow(flowId: string): void {
    const result = this.port(() => this.database.prepare(
      "DELETE FROM flows WHERE id = ?",
    ).run(flowId));
    if (result.changes === 0) {
      throw new RepositoryError("FLOW_NOT_FOUND", "flow not found");
    }
  }

  loadFlow(flowId: string): Flow | undefined {
    return this.sqlite(() => this.loadFlowDirect(flowId));
  }

  listFlows(): Flow[] {
    return this.sqlite(() => {
      const rows = this.database.prepare("SELECT id FROM flows ORDER BY name, id").all() as Array<{
        id: string;
      }>;
      return rows.map(({ id }) => this.loadFlowDirect(id)!);
    });
  }

  createRun(runId: string, state: RunState): void {
    this.createStoredRun(runId, state, storedRunFromState(state));
  }

  createRunForFlow(runId: string, state: RunState, flow: Flow): void {
    const stored = storedRunFromState(state);
    stored.flow_id = flow.id;
    stored.flow_name = flow.name;
    stored.flow_version = flow.version;
    stored.step_titles = stepTitlesForFlow(flow);
    this.createStoredRun(runId, state, stored);
  }

  createBoundRun(runId: string, state: RunState, binding: RunBinding): void {
    this.createStoredRun(runId, state, storedRunFromBinding(state, binding));
  }

  appendRun(runId: string, state: RunState): void {
    this.writeRun(runId, state, storedRunFromState(state), false);
  }

  appendBoundRun(runId: string, state: RunState, binding: RunBinding): void {
    this.writeRun(runId, state, storedRunFromBinding(state, binding), false);
  }

  loadRun(runId: string): RunState | undefined {
    const row = this.sqlite(() => this.database.prepare(
      "SELECT state_json FROM runs WHERE id = ?",
    ).get(runId)) as { state_json: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return this.deserializeRun(row.state_json);
  }

  listRuns(): RunHistoryEntry[] {
    const rows = this.sqlite(() => this.database.prepare(`
      SELECT id, state_json, started_at_ms, ended_at_ms
      FROM runs
      ORDER BY started_at_ms DESC, id DESC
    `).all()) as Array<{
      id: string;
      state_json: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }>;
    return rows.map((row) => {
      const stored = parseStoredRun(row.state_json);
      return {
        runId: row.id,
        flowId: stored.flow_id,
        flowName: stored.flow_name ?? (stored.flow_id === undefined
          ? undefined
          : this.loadFlowDirect(stored.flow_id)?.name),
        sourceDbName: stored.source_db_name ?? stored.binding?.source_connection_id,
        targetDbName: stored.target_db_name ?? stored.binding?.target_connection_id,
        flowVersion: stored.flow_version,
        stepTitles: stored.step_titles ?? [],
        startedAtMs: row.started_at_ms,
        endedAtMs: row.ended_at_ms ?? undefined,
        state: stateFromStoredRun(stored),
      };
    });
  }

  deleteRun(runId: string): boolean {
    return this.port(() => this.database.transaction(() => {
      const row = this.database.prepare("SELECT state_json FROM runs WHERE id = ?").get(runId) as
        | { state_json: string }
        | undefined;
      if (row === undefined) {
        return false;
      }
      if (!isTerminal(stateFromStoredRun(parseStoredRun(row.state_json)).status())) {
        throw new RepositoryError("RUN_NOT_DELETABLE", "unfinished run history cannot be deleted");
      }
      this.database.prepare("DELETE FROM run_steps WHERE run_id = ?").run(runId);
      this.database.prepare("DELETE FROM recovery_events WHERE run_id = ?").run(runId);
      this.database.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      return true;
    })());
  }

  clearRuns(): number {
    return this.port(() => this.database.transaction(() => {
      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count;
      this.database.prepare("DELETE FROM run_steps").run();
      this.database.prepare("DELETE FROM recovery_events").run();
      this.database.prepare("DELETE FROM runs").run();
      return count;
    })());
  }

  loadRunBinding(runId: string): RunBinding | undefined {
    const row = this.sqlite(() => this.database.prepare(
      "SELECT state_json FROM runs WHERE id = ?",
    ).get(runId)) as { state_json: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const binding = parseStoredRun(row.state_json).binding;
    if (binding === undefined) {
      return undefined;
    }
    const flow = this.loadFlow(binding.flow_id);
    const sourceProfile = this.loadConnection(binding.source_connection_id);
    const targetProfile = this.loadConnection(binding.target_connection_id);
    if (flow === undefined || sourceProfile === undefined || targetProfile === undefined) {
      return undefined;
    }
    const current = { flow, sourceProfile, targetProfile };
    return bindingMatches(binding, current) ? current : undefined;
  }

  applyBoundRecovery(
    runId: string,
    state: RunState,
    expectedState: RunState,
    expectedBinding: RunBinding,
    persistedBinding: RunBinding,
    updatedFlow?: Flow,
  ): BoundRecoveryApply {
    return this.port(() => this.database.transaction(() => {
      const row = this.database.prepare("SELECT state_json FROM runs WHERE id = ?").get(runId) as
        | { state_json: string }
        | undefined;
      if (row === undefined) {
        return "recovery_no_longer_available";
      }
      const currentStored = parseStoredRun(row.state_json);
      const currentState = stateFromStoredRun(currentStored);
      const status = currentState.status();
      const recoveryAvailable = typeof status === "object"
        && ("awaiting_recovery" in status || "recovery_pending" in status);
      if (!recoveryAvailable
        || !sameJson(currentState.toJSON(), expectedState.toJSON())
        || currentStored.binding === undefined
        || !bindingMatches(currentStored.binding, expectedBinding)) {
        return "recovery_no_longer_available";
      }
      const currentFlow = this.loadFlowDirect(expectedBinding.flow.id);
      const source = this.loadConnectionDirect(expectedBinding.sourceProfile.id);
      const target = this.loadConnectionDirect(expectedBinding.targetProfile.id);
      if (!sameJson(currentFlow, expectedBinding.flow)
        || !sameJson(source, expectedBinding.sourceProfile)
        || !sameJson(target, expectedBinding.targetProfile)) {
        return "configuration_changed";
      }
      if (updatedFlow !== undefined) {
        if (updatedFlow.version !== expectedBinding.flow.version + 1) {
          return "configuration_changed";
        }
        const result = this.database.prepare(`
          UPDATE flows SET name = ?, source_connection_id = ?, target_connection_id = ?,
            transaction_policy = ?, version = ?
          WHERE id = ? AND version = ?
        `).run(
          updatedFlow.name,
          updatedFlow.sourceConnectionId,
          updatedFlow.targetConnectionId,
          updatedFlow.transactionPolicy,
          updatedFlow.version,
          updatedFlow.id,
          expectedBinding.flow.version,
        );
        if (result.changes !== 1) {
          return "configuration_changed";
        }
        this.replaceFlowSteps(updatedFlow);
      }
      this.writeRunDirect(runId, state, storedRunFromBinding(state, persistedBinding), false);
      return "applied";
    }).immediate());
  }

  historyJsonForTest(runId: string): string | undefined {
    const row = this.database.prepare("SELECT state_json FROM runs WHERE id = ?").get(runId) as
      | { state_json: string }
      | undefined;
    return row?.state_json;
  }

  private initialize(): void {
    this.sqlite(() => {
      this.database.pragma("foreign_keys = ON");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS connection_profiles (
          id TEXT PRIMARY KEY NOT NULL,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          service_name TEXT NOT NULL,
          username TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          credential_storage TEXT NOT NULL DEFAULT 'keyring',
          plaintext_password TEXT,
          enabled INTEGER NOT NULL,
          source_read_only INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          source_connection_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE RESTRICT,
          target_connection_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE RESTRICT,
          transaction_policy TEXT NOT NULL,
          version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS query_steps (
          flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          select_sql TEXT NOT NULL,
          upsert_sql TEXT NOT NULL,
          PRIMARY KEY (flow_id, position)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY NOT NULL,
          state_json TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL DEFAULT 0,
          ended_at_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS run_steps (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          status_json TEXT NOT NULL,
          PRIMARY KEY (run_id, position)
        );
        CREATE TABLE IF NOT EXISTS recovery_events (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          position INTEGER NOT NULL,
          action TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
      `);
      this.addColumnIfMissing("connection_profiles", "credential_storage", "credential_storage TEXT NOT NULL DEFAULT 'keyring'");
      this.addColumnIfMissing("connection_profiles", "plaintext_password", "plaintext_password TEXT");
      this.addColumnIfMissing("connection_profiles", "source_read_only", "source_read_only INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing("runs", "started_at_ms", "started_at_ms INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing("runs", "ended_at_ms", "ended_at_ms INTEGER");
      this.addColumnIfMissing("query_steps", "title", "title TEXT NOT NULL DEFAULT ''");
      this.migrateLegacySchema();
      this.migrateLegacyRunHistory();
    });
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }

  private migrateLegacySchema(): void {
    const flowReferences = this.database.prepare("PRAGMA foreign_key_list(flows)").all() as Array<{
      table: string;
      from: string;
    }>;
    const rebuildFlows = flowReferences.filter((reference) =>
      reference.table === "connection_profiles"
      && ["source_connection_id", "target_connection_id"].includes(reference.from)).length !== 2;
    const recoveryColumns = this.database.prepare("PRAGMA table_info(recovery_events)").all() as
      Array<{ name: string }>;
    const rebuildRecovery = !recoveryColumns.some(({ name }) => name === "sequence");
    if (!rebuildFlows && !rebuildRecovery) {
      return;
    }

    this.database.pragma("foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        if (rebuildFlows) {
          this.database.exec(`
            ALTER TABLE query_steps RENAME TO query_steps_legacy;
            ALTER TABLE flows RENAME TO flows_legacy;
            CREATE TABLE flows (
              id TEXT PRIMARY KEY NOT NULL,
              name TEXT NOT NULL,
              source_connection_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE RESTRICT,
              target_connection_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE RESTRICT,
              transaction_policy TEXT NOT NULL,
              version INTEGER NOT NULL
            );
            CREATE TABLE query_steps (
              flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
              position INTEGER NOT NULL,
              id TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT '',
              select_sql TEXT NOT NULL,
              upsert_sql TEXT NOT NULL,
              PRIMARY KEY (flow_id, position)
            );
            INSERT INTO flows
              SELECT legacy.* FROM flows_legacy AS legacy
              WHERE EXISTS (SELECT 1 FROM connection_profiles WHERE id = legacy.source_connection_id)
                AND EXISTS (SELECT 1 FROM connection_profiles WHERE id = legacy.target_connection_id);
            INSERT INTO query_steps
              SELECT legacy.* FROM query_steps_legacy AS legacy
              WHERE EXISTS (SELECT 1 FROM flows WHERE id = legacy.flow_id);
            DROP TABLE query_steps_legacy;
            DROP TABLE flows_legacy;
          `);
        }
        if (rebuildRecovery) {
          this.database.exec(`
            ALTER TABLE recovery_events RENAME TO recovery_events_legacy;
            CREATE TABLE recovery_events (
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              sequence INTEGER NOT NULL,
              position INTEGER NOT NULL,
              action TEXT NOT NULL,
              PRIMARY KEY (run_id, sequence)
            );
            INSERT INTO recovery_events (run_id, sequence, position, action)
              SELECT legacy.run_id, legacy.rowid, legacy.position, legacy.action
              FROM recovery_events_legacy AS legacy
              WHERE EXISTS (SELECT 1 FROM runs WHERE id = legacy.run_id);
            DROP TABLE recovery_events_legacy;
          `);
        }
        this.database.exec(`
          DELETE FROM run_steps
          WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = run_steps.run_id);
          DELETE FROM recovery_events
          WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = recovery_events.run_id);
        `);
      }).immediate();
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error("foreign key migration failed");
    }
  }

  private migrateLegacyRunHistory(): void {
    this.database.transaction(() => {
      const rows = this.database.prepare("SELECT id, state_json FROM runs").all() as Array<{
        id: string;
        state_json: string;
      }>;
      for (const row of rows) {
        const stored = normalizeInterruptedRun(parseLegacyStoredRun(row.state_json));
        this.database.prepare(`
          UPDATE runs SET state_json = ?,
            ended_at_ms = CASE
              WHEN ended_at_ms IS NULL AND ? THEN ?
              ELSE ended_at_ms
            END
          WHERE id = ?
        `).run(JSON.stringify(stored), isTerminal(stored.status) ? 1 : 0, Date.now(), row.id);
      }
    }).immediate();
  }

  private createStoredRun(runId: string, state: RunState, stored: StoredRun): void {
    if (this.database.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) !== undefined) {
      throw new RepositoryError("RUN_ID_COLLISION", "run ID is already in use");
    }
    this.writeRun(runId, state, stored, true);
  }

  private writeRun(runId: string, state: RunState, stored: StoredRun, insertOnly: boolean): void {
    this.port(() => this.database.transaction(() => {
      this.writeRunDirect(runId, state, stored, insertOnly);
    })());
  }

  private writeRunDirect(runId: string, state: RunState, stored: StoredRun, insertOnly: boolean): void {
    const now = Date.now();
    if (insertOnly) {
      this.database.prepare(`
        INSERT INTO runs (id, state_json, started_at_ms, ended_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(runId, JSON.stringify(stored), now, isTerminal(state.status()) ? now : null);
    } else {
      this.database.prepare(`
        INSERT INTO runs (id, state_json, started_at_ms, ended_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state_json = excluded.state_json,
          ended_at_ms = CASE
            WHEN runs.ended_at_ms IS NULL AND excluded.ended_at_ms IS NOT NULL
              THEN excluded.ended_at_ms
            ELSE runs.ended_at_ms
          END
      `).run(runId, JSON.stringify(stored), now, isTerminal(state.status()) ? now : null);
    }
    this.database.prepare("DELETE FROM run_steps WHERE run_id = ?").run(runId);
    this.database.prepare("DELETE FROM recovery_events WHERE run_id = ?").run(runId);
    const insertStep = this.database.prepare(
      "INSERT INTO run_steps (run_id, position, status_json) VALUES (?, ?, ?)",
    );
    state.steps().forEach((step, position) => {
      insertStep.run(runId, position, JSON.stringify(step.status));
    });
    const insertRecovery = this.database.prepare(`
      INSERT INTO recovery_events (run_id, sequence, position, action)
      VALUES (?, ?, ?, ?)
    `);
    state.events().forEach((event, sequence) => {
      if (event.type === "recovery_applied") {
        insertRecovery.run(runId, sequence, event.step, event.action);
      }
    });
  }

  private replaceFlowSteps(flow: Flow): void {
    this.database.prepare("DELETE FROM query_steps WHERE flow_id = ?").run(flow.id);
    const insert = this.database.prepare(`
      INSERT INTO query_steps (flow_id, position, id, title, select_sql, upsert_sql)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    flow.querySteps.forEach((step, position) => {
      insert.run(flow.id, position, step.id, step.title?.trim() || `Step ${position + 1}`, step.selectSql, step.upsertSql);
    });
  }

  private loadFlowDirect(flowId: string): Flow | undefined {
    const row = this.database.prepare(`
      SELECT id, name, source_connection_id, target_connection_id,
             transaction_policy, version
      FROM flows WHERE id = ?
    `).get(flowId) as {
      id: string;
      name: string;
      source_connection_id: string;
      target_connection_id: string;
      transaction_policy: Flow["transactionPolicy"];
      version: number;
    } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const steps = this.database.prepare(`
      SELECT id, title, select_sql, upsert_sql
      FROM query_steps WHERE flow_id = ? ORDER BY position
    `).all(flowId) as Array<{ id: string; title: string; select_sql: string; upsert_sql: string }>;
    return {
      id: row.id,
      name: row.name,
      sourceConnectionId: row.source_connection_id,
      targetConnectionId: row.target_connection_id,
      transactionPolicy: row.transaction_policy,
      version: row.version,
      querySteps: steps.map(queryStepFromRow),
    };
  }

  private loadConnectionDirect(connectionId: string): ConnectionProfile | undefined {
    const row = this.database.prepare(`
      SELECT id, display_name, kind, host, port, service_name, username,
             credential_ref, credential_storage, plaintext_password, enabled,
             source_read_only
      FROM connection_profiles WHERE id = ?
    `).get(connectionId) as ConnectionRow | undefined;
    return row === undefined ? undefined : connectionFromRow(row);
  }

  private deserializeRun(json: string): RunState {
    try {
      return stateFromStoredRun(parseStoredRun(json));
    } catch {
      throw new RepositoryError(
        "HISTORY_DESERIALIZATION",
        "run history could not be loaded",
      );
    }
  }

  private sqlite<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw error;
      }
      throw new RepositoryError("SQLITE", "local metadata storage failed");
    }
  }

  private port<T>(operation: () => T): T {
    return this.sqlite(operation);
  }
}

function connectionParameters(profile: ConnectionProfile): Record<string, unknown> {
  return {
    id: profile.id,
    displayName: profile.displayName,
    kind: profile.kind,
    host: profile.host,
    port: profile.port,
    sid: profile.sid,
    username: profile.username,
    credentialRef: profile.credentialRef,
    credentialStorage: profile.credentialStorage,
    plaintextPassword: profile.plaintextPassword ?? null,
    enabled: profile.enabled ? 1 : 0,
    sourceReadOnly: profile.sourceReadOnly ? 1 : 0,
  };
}

function connectionFromRow(row: ConnectionRow): ConnectionProfile {
  if (row.kind !== "oracle"
    || (row.credential_storage !== "keyring" && row.credential_storage !== "plaintext")) {
    throw new RepositoryError("SQLITE", "local metadata storage failed");
  }
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    host: row.host,
    port: row.port,
    sid: row.service_name,
    username: row.username,
    credentialRef: row.credential_ref,
    credentialStorage: row.credential_storage as CredentialStorage,
    plaintextPassword: row.plaintext_password,
    enabled: row.enabled !== 0,
    sourceReadOnly: row.source_read_only !== 0,
  };
}

function queryStepFromRow(row: { id: string; title: string; select_sql: string; upsert_sql: string }, position: number): QueryStep {
  return { id: row.id, title: row.title.trim() || `Step ${position + 1}`, selectSql: row.select_sql, upsertSql: row.upsert_sql };
}

function storedRunFromBinding(state: RunState, binding: RunBinding): StoredRun {
  const stored = storedRunFromState(state);
  stored.flow_id = binding.flow.id;
  stored.flow_name = binding.flow.name;
  stored.source_db_name = binding.sourceProfile.displayName;
  stored.target_db_name = binding.targetProfile.displayName;
  stored.flow_version = binding.flow.version;
  stored.step_titles = stepTitlesForFlow(binding.flow);
  stored.binding = storedBinding(binding);
  return stored;
}

function storedRunFromState(state: RunState): StoredRun {
  const data = state.toJSON();
  return sanitizeStoredRun({
    policy: data.policy,
    status: data.status,
    steps: data.steps.map((step) => step.status),
    events: data.events.map(storedEvent),
  });
}

function storedEvent(event: RunEvent): StoredRunEvent {
  switch (event.type) {
    case "step_succeeded":
      return event;
    case "step_failed":
      return {
        type: event.type,
        step: event.step,
        error_code: historyCode(event.error),
        error_message: safeHistoryMessage(event.error),
        retryable: connectorRetryable(event.error),
      };
    case "transaction_failed":
      return {
        type: event.type,
        error_code: historyCode(event.error),
        error_message: safeHistoryMessage(event.error),
        retryable: connectorRetryable(event.error),
      };
    case "recovery_applied":
      return event;
  }
}

function stateFromStoredRun(stored: StoredRun): RunState {
  return RunState.fromHistory(
    stored.policy,
    stored.status,
    stored.steps,
    stored.events.map((event): RunEvent => {
      switch (event.type) {
        case "step_succeeded":
        case "recovery_applied":
          return event;
        case "step_failed":
          return {
            type: event.type,
            step: event.step,
            error: RunError.connectorWithRetryable(
              event.error_code,
              safeConnectorDiagnostic(event.error_code, event.error_message)
                ?? sanitizeHistoryMessage(event.error_message),
              event.retryable,
            ).toJSON(),
          };
        case "transaction_failed":
          return {
            type: event.type,
            error: RunError.connectorWithRetryable(
              event.error_code,
              safeConnectorDiagnostic(event.error_code, event.error_message)
                ?? sanitizeHistoryMessage(event.error_message),
              event.retryable,
            ).toJSON(),
          };
      }
    }),
  );
}

function parseStoredRun(json: string): StoredRun {
  return sanitizeStoredRun(JSON.parse(json) as StoredRun);
}

function parseLegacyStoredRun(json: string): StoredRun {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const data = legacyRunData(value);
    return sanitizeStoredRun(data);
  } catch {
    return {
      policy: "all_or_nothing",
      status: "failed",
      steps: [],
      events: [],
    };
  }
}

function legacyRunData(value: Record<string, unknown>): StoredRun {
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step) => {
      if (typeof step === "object" && step !== null && "status" in step) {
        return (step as { status: StepStatus }).status;
      }
      return step as StepStatus;
    })
    : [];
  const events = Array.isArray(value.events)
    ? value.events.map((event) => legacyStoredEvent(event as Record<string, unknown>))
    : [];
  const binding = legacyStoredBinding(value.binding);
  return {
    policy: value.policy === "commit_successes" ? "commit_successes" : "all_or_nothing",
    status: value.status as RunStatus ?? "failed",
    steps,
    events,
    flow_id: typeof value.flow_id === "string" ? value.flow_id : binding?.flow_id,
    flow_version: typeof value.flow_version === "number" ? value.flow_version : binding?.flow_version,
    binding,
  };
}

function legacyStoredEvent(event: Record<string, unknown>): StoredRunEvent {
  if (event.type === "step_succeeded") {
    return { type: event.type, step: Number(event.step), affected_rows: Number(event.affected_rows) };
  }
  if (event.type === "recovery_applied") {
    return {
      type: event.type,
      step: Number(event.step),
      action: event.action as RecoveryAction,
    };
  }
  const error = event.error as RunErrorData | undefined;
  const errorCode = typeof event.error_code === "string"
    ? event.error_code
    : error === undefined ? "CONNECTOR_ERROR" : historyCode(error);
  const errorMessage = typeof event.error_message === "string"
    ? event.error_message
    : error?.type === "connector" ? error.detail.message : "";
  const retryable = typeof event.retryable === "boolean"
    ? event.retryable
    : error?.type === "connector" && error.detail.retryable;
  if (event.type === "step_failed") {
    return {
      type: event.type,
      step: Number(event.step),
      error_code: errorCode,
      error_message: errorMessage,
      retryable,
    };
  }
  return { type: "transaction_failed", error_code: errorCode, error_message: errorMessage, retryable };
}

function legacyStoredBinding(value: unknown): StoredRunBinding | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const binding = value as Record<string, unknown>;
  if (typeof binding.flow_id === "string") {
    return binding as StoredRunBinding;
  }
  const flow = binding.flow as Record<string, unknown> | undefined;
  const source = binding.source_profile as Record<string, unknown> | undefined;
  const target = binding.target_profile as Record<string, unknown> | undefined;
  if (flow === undefined || source === undefined || target === undefined) {
    return undefined;
  }
  const converted: RunBinding = {
    flow: flowFromLegacy(flow),
    sourceProfile: connectionFromLegacy(source),
    targetProfile: connectionFromLegacy(target),
  };
  return storedBinding(converted);
}

function flowFromLegacy(flow: Record<string, unknown>): Flow {
  return {
    id: String(flow.id),
    name: String(flow.name),
    sourceConnectionId: String(flow.source_connection_id),
    targetConnectionId: String(flow.target_connection_id),
    querySteps: [],
    transactionPolicy: flow.transaction_policy as Flow["transactionPolicy"],
    version: Number(flow.version),
  };
}

function connectionFromLegacy(profile: Record<string, unknown>): ConnectionProfile {
  return {
    id: String(profile.id),
    displayName: String(profile.display_name),
    kind: "oracle",
    host: String(profile.host),
    port: Number(profile.port),
    sid: String(profile.sid ?? profile.service_name),
    username: String(profile.username),
    credentialRef: String(profile.credential_ref),
    credentialStorage: profile.credential_storage === "plaintext" ? "plaintext" : "keyring",
    plaintextPassword: typeof profile.plaintext_password === "string"
      ? profile.plaintext_password
      : undefined,
    enabled: profile.enabled === true,
    sourceReadOnly: profile.source_read_only === true,
  };
}

function sanitizeStoredRun(stored: StoredRun): StoredRun {
  const result = structuredClone(stored);
  if (result.flow_id === undefined && result.binding !== undefined) {
    result.flow_id = result.binding.flow_id;
    result.flow_version = result.binding.flow_version;
  }
  if (typeof result.status === "object" && "in_doubt" in result.status) {
    result.status.in_doubt.reason = RunError.connector(
      historyCode(result.status.in_doubt.reason),
      "sanitized persisted transaction error",
    ).toJSON();
  }
  result.events = result.events.map((event) => {
    if (event.type === "step_failed" || event.type === "transaction_failed") {
      return {
        ...event,
        error_code: historyCode(RunError.connector(event.error_code, "").toJSON()),
        error_message: safeConnectorDiagnostic(event.error_code, event.error_message ?? "")
          ?? sanitizeHistoryMessage(event.error_message ?? ""),
        retryable: event.retryable ?? false,
      };
    }
    return event;
  });
  return result;
}

function normalizeInterruptedRun(stored: StoredRun): StoredRun {
  if (typeof stored.status === "object" && "recovery_pending" in stored.status) {
    stored.status = {
      awaiting_recovery: { failed_step: stored.status.recovery_pending.failed_step },
    };
  } else if (typeof stored.status === "object" && "commit_pending" in stored.status) {
    stored.status = {
      in_doubt: {
        step: stored.status.commit_pending.step,
        reason: RunError.connector(
          "COMMIT_OUTCOME_UNKNOWN",
          "commit outcome could not be confirmed",
        ).toJSON(),
      },
    };
  }
  return sanitizeStoredRun(stored);
}

function storedBinding(binding: RunBinding): StoredRunBinding {
  return {
    flow_id: binding.flow.id,
    flow_version: binding.flow.version,
    source_connection_id: binding.sourceProfile.id,
    source_signature: connectionSignature(binding.sourceProfile),
    target_connection_id: binding.targetProfile.id,
    target_signature: connectionSignature(binding.targetProfile),
  };
}

function bindingMatches(stored: StoredRunBinding, binding: RunBinding): boolean {
  return sameJson(stored, storedBinding(binding));
}

function connectionSignature(profile: ConnectionProfile): string {
  const material = [
    "Oracle",
    profile.host,
    String(profile.port),
    profile.sid,
    profile.username,
    String(profile.enabled),
  ].join("\u001f");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(material)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function historyCode(error: RunErrorData): string {
  return RunError.fromJSON(error).historyCode();
}

function connectorRetryable(error: RunErrorData): boolean {
  return error.type === "connector" && error.detail.retryable;
}

function safeHistoryMessage(error: RunErrorData): string {
  if (error.type !== "connector") {
    return "sanitized persisted run error";
  }
  return safeConnectorDiagnostic(error.detail.code, error.detail.message)
    ?? sanitizeHistoryMessage(error.detail.message);
}

function stepTitlesForFlow(flow: Flow): string[] {
  return flow.querySteps.map((step, position) => step.title?.trim() || `Step ${position + 1}`);
}

function sanitizeHistoryMessage(message: string): string {
  const normalized = message.trim().toLowerCase();
  const explicitlySafe = new Set([
    "connection failed",
    "connection refused",
    "connection timed out",
    "unique constraint violated",
  ]);
  return explicitlySafe.has(normalized) ? normalized : "sanitized persisted run error";
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed"
    || status === "rolled_back"
    || status === "stopped_by_user"
    || status === "failed"
    || (typeof status === "object" && "in_doubt" in status);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
