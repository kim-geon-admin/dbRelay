use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{
    application::ports::{FlowRepository, HistoryRepository, PortError},
    domain::{
        ConnectionProfile, DbKind, Flow, QueryStep, RecoveryAction, RunError, RunEvent, RunState,
        RunStatus, StepStatus, TransactionPolicy,
    },
};

pub struct SqliteStore {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Deserialize, Serialize)]
struct StoredRun {
    policy: TransactionPolicy,
    status: RunStatus,
    steps: Vec<StepStatus>,
    events: Vec<StoredRunEvent>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
enum StoredRunEvent {
    StepSucceeded { step: usize, affected_rows: u64 },
    StepFailed { step: usize, error_code: String },
    RecoveryApplied { step: usize, action: RecoveryAction },
}

impl StoredRun {
    fn from_state(state: &RunState) -> Self {
        Self {
            policy: state.policy(),
            status: state.status(),
            steps: state
                .steps()
                .iter()
                .map(|step| step.status.clone())
                .collect(),
            events: state
                .events()
                .iter()
                .map(StoredRunEvent::from_run_event)
                .collect(),
        }
    }

    fn into_state(self) -> RunState {
        let events = self
            .events
            .into_iter()
            .map(StoredRunEvent::into_run_event)
            .collect();
        RunState::from_history(self.policy, self.status, self.steps, events)
    }
}

impl StoredRunEvent {
    fn from_run_event(event: &RunEvent) -> Self {
        match event {
            RunEvent::StepSucceeded {
                step,
                affected_rows,
            } => Self::StepSucceeded {
                step: *step,
                affected_rows: *affected_rows,
            },
            RunEvent::StepFailed { step, error } => Self::StepFailed {
                step: *step,
                error_code: error.history_code(),
            },
            RunEvent::RecoveryApplied { step, action } => Self::RecoveryApplied {
                step: *step,
                action: *action,
            },
        }
    }

    fn into_run_event(self) -> RunEvent {
        match self {
            Self::StepSucceeded {
                step,
                affected_rows,
            } => RunEvent::StepSucceeded {
                step,
                affected_rows,
            },
            Self::StepFailed { step, error_code } => RunEvent::StepFailed {
                step,
                error: RunError::connector(error_code, "sanitized persisted run error"),
            },
            Self::RecoveryApplied { step, action } => RunEvent::RecoveryApplied { step, action },
        }
    }
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, PortError> {
        let connection = Connection::open(path).map_err(sqlite_error)?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self, PortError> {
        Self::from_connection(Connection::open_in_memory().map_err(sqlite_error)?)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, PortError> {
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS connection_profiles (
                    id TEXT PRIMARY KEY NOT NULL,
                    display_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    service_name TEXT NOT NULL,
                    username TEXT NOT NULL,
                    credential_ref TEXT NOT NULL,
                    enabled INTEGER NOT NULL
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
                    select_sql TEXT NOT NULL,
                    upsert_sql TEXT NOT NULL,
                    PRIMARY KEY (flow_id, position)
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY NOT NULL,
                    state_json TEXT NOT NULL
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
                ",
        )
            .map_err(sqlite_error)?;
        migrate_legacy_schema(&mut connection).map_err(sqlite_error)?;
        migrate_legacy_run_history(&mut connection).map_err(sqlite_error)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO connection_profiles
                    (id, display_name, kind, host, port, service_name, username, credential_ref, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    display_name = excluded.display_name,
                    kind = excluded.kind,
                    host = excluded.host,
                    port = excluded.port,
                    service_name = excluded.service_name,
                    username = excluded.username,
                    credential_ref = excluded.credential_ref,
                    enabled = excluded.enabled",
                params![
                    profile.id,
                    profile.display_name,
                    db_kind(profile.kind),
                    profile.host,
                    profile.port,
                    profile.service_name,
                    profile.username,
                    profile.credential_ref,
                    profile.enabled as i64,
                ],
            )?;
            Ok(())
        })
    }

    pub fn update_connection_without_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<(), PortError> {
        let existing = self.load_connection(profile.id.as_str())?;
        let mut updated = profile.clone();
        updated.credential_ref = existing.credential_ref;
        self.save_connection(&updated)
    }

    pub fn load_connection(&self, connection_id: &str) -> Result<ConnectionProfile, PortError> {
        self.load_connection_optional(connection_id)?
            .ok_or_else(|| PortError::new("CONNECTION_NOT_FOUND", "connection not found"))
    }

    pub fn load_runnable_connection(
        &self,
        connection_id: &str,
    ) -> Result<ConnectionProfile, PortError> {
        let profile = self.load_connection(connection_id)?;
        if !profile.enabled {
            return Err(PortError::new(
                "CONNECTION_DISABLED",
                "connection is disabled",
            ));
        }
        Ok(profile)
    }

    pub fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, display_name, kind, host, port, service_name, username, credential_ref, enabled
                 FROM connection_profiles ORDER BY display_name, id",
            )?;
            let profiles = statement
                .query_map([], connection_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(profiles)
        })
    }

    pub fn disable_connection(&self, connection_id: &str) -> Result<(), PortError> {
        let changed = self.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE connection_profiles SET enabled = 0 WHERE id = ?1",
                [connection_id],
            )?;
            Ok(changed)
        })?;
        if changed == 0 {
            return Err(PortError::new(
                "CONNECTION_NOT_FOUND",
                "connection not found",
            ));
        }
        Ok(())
    }

    pub fn delete_connection(&self, connection_id: &str) -> Result<(), PortError> {
        let outcome = self.with_connection(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM connection_profiles WHERE id = ?1)",
                [connection_id],
                |row| row.get::<_, bool>(0),
            )?;
            let referenced = transaction.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM flows
                    WHERE source_connection_id = ?1 OR target_connection_id = ?1
                )",
                [connection_id],
                |row| row.get::<_, bool>(0),
            )?;
            let deleted = if exists && !referenced {
                transaction.execute(
                    "DELETE FROM connection_profiles WHERE id = ?1",
                    [connection_id],
                )?;
                true
            } else {
                false
            };
            transaction.commit()?;
            Ok((exists, referenced, deleted))
        })?;
        if outcome.1 {
            return Err(PortError::new(
                "CONNECTION_REFERENCED",
                "connection is referenced by a flow",
            ));
        }
        if !outcome.0 || !outcome.2 {
            return Err(PortError::new(
                "CONNECTION_NOT_FOUND",
                "connection not found",
            ));
        }
        Ok(())
    }

    pub fn save_flow(&self, flow: &Flow) -> Result<(), PortError> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO flows (id, name, source_connection_id, target_connection_id, transaction_policy, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    source_connection_id = excluded.source_connection_id,
                    target_connection_id = excluded.target_connection_id,
                    transaction_policy = excluded.transaction_policy,
                    version = excluded.version",
                params![
                    flow.id,
                    flow.name,
                    flow.source_connection_id,
                    flow.target_connection_id,
                    transaction_policy(flow.transaction_policy),
                    flow.version,
                ],
            )?;
            transaction.execute("DELETE FROM query_steps WHERE flow_id = ?1", [&flow.id])?;
            for (position, step) in flow.query_steps.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO query_steps (flow_id, position, id, select_sql, upsert_sql)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![flow.id, position as i64, step.id, step.select_sql, step.upsert_sql],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn load_flow(&self, flow_id: &str) -> Result<Flow, PortError> {
        self.load_flow_optional(flow_id)?
            .ok_or_else(|| PortError::new("FLOW_NOT_FOUND", "flow not found"))
    }

    pub fn list_flows(&self) -> Result<Vec<Flow>, PortError> {
        self.with_connection(|connection| {
            let ids = {
                let mut statement = connection.prepare("SELECT id FROM flows ORDER BY name, id")?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                ids
            };
            ids.into_iter()
                .map(|id| load_flow_from_connection(connection, &id))
                .collect()
        })
    }

    pub fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        let stored_run = StoredRun::from_state(state);
        let state_json = serde_json::to_string(&stored_run).map_err(|_| {
            PortError::new("HISTORY_SERIALIZATION", "run history could not be saved")
        })?;
        let step_statuses = state
            .steps()
            .iter()
            .enumerate()
            .map(|(position, step)| {
                serde_json::to_string(&step.status)
                    .map(|status_json| (position, status_json))
                    .map_err(|_| {
                        PortError::new("HISTORY_SERIALIZATION", "run history could not be saved")
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO runs (id, state_json) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
                params![run_id, state_json],
            )?;
            transaction.execute("DELETE FROM run_steps WHERE run_id = ?1", [run_id])?;
            transaction.execute("DELETE FROM recovery_events WHERE run_id = ?1", [run_id])?;
            for (position, status_json) in &step_statuses {
                transaction.execute(
                    "INSERT INTO run_steps (run_id, position, status_json) VALUES (?1, ?2, ?3)",
                    params![run_id, *position as i64, status_json],
                )?;
            }
            for (sequence, event) in state.events().iter().enumerate() {
                if let RunEvent::RecoveryApplied { step, action } = event {
                    transaction.execute(
                        "INSERT INTO recovery_events (run_id, sequence, position, action) VALUES (?1, ?2, ?3, ?4)",
                        params![run_id, sequence as i64, *step as i64, recovery_action(*action)],
                    )?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
    }

    pub fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError> {
        let state_json: Option<String> = self.with_connection(|connection| {
            let state_json = connection
                .query_row(
                    "SELECT state_json FROM runs WHERE id = ?1",
                    [run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(state_json)
        })?;
        state_json
            .map(|json| {
                serde_json::from_str::<StoredRun>(&json)
                    .map(StoredRun::into_state)
                    .map_err(|_| {
                        PortError::new("HISTORY_DESERIALIZATION", "run history could not be loaded")
                    })
            })
            .transpose()
    }

    #[doc(hidden)]
    pub fn recovery_event_count_for_test(&self, run_id: &str) -> usize {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM recovery_events WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )
        })
        .unwrap_or_default()
    }

    #[doc(hidden)]
    pub fn dump_for_test(&self) -> String {
        self.with_connection(|connection| {
            let mut output = String::new();
            for table in [
                "connection_profiles",
                "flows",
                "query_steps",
                "runs",
                "run_steps",
                "recovery_events",
            ] {
                let mut statement = connection.prepare(&format!("SELECT * FROM {table}"))?;
                let column_count = statement.column_count();
                let rows = statement.query_map([], |row| {
                    let mut values = Vec::with_capacity(column_count);
                    for index in 0..column_count {
                        values.push(row.get::<_, String>(index).unwrap_or_default());
                    }
                    Ok(values.join("|"))
                })?;
                for row in rows {
                    output.push_str(&row?);
                    output.push('\n');
                }
            }
            Ok(output)
        })
        .unwrap_or_default()
    }

    fn load_connection_optional(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, display_name, kind, host, port, service_name, username, credential_ref, enabled
                     FROM connection_profiles WHERE id = ?1",
                    [connection_id],
                    connection_from_row,
                )
                .optional()
        })
    }

    fn load_flow_optional(&self, flow_id: &str) -> Result<Option<Flow>, PortError> {
        self.with_connection(|connection| {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM flows WHERE id = ?1)",
                [flow_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Ok(None);
            }
            load_flow_from_connection(connection, flow_id).map(Some)
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, PortError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| PortError::new("SQLITE_LOCK", "local database lock is unavailable"))?;
        operation(&mut connection).map_err(sqlite_error)
    }
}

#[async_trait]
impl FlowRepository for SqliteStore {
    async fn load_flow(&self, flow_id: &str) -> Result<Option<Flow>, PortError> {
        self.load_flow_optional(flow_id)
    }

    async fn save_flow(&self, flow: &Flow) -> Result<(), PortError> {
        SqliteStore::save_flow(self, flow)
    }

    async fn list_flows(&self) -> Result<Vec<Flow>, PortError> {
        SqliteStore::list_flows(self)
    }

    async fn load_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        self.load_connection_optional(connection_id)
    }

    async fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        SqliteStore::save_connection(self, profile)
    }

    async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError> {
        SqliteStore::list_connections(self)
    }

    async fn update_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        self.update_connection_without_credential(profile)
    }

    async fn disable_connection(&self, connection_id: &str) -> Result<(), PortError> {
        SqliteStore::disable_connection(self, connection_id)
    }

    async fn delete_connection(&self, connection_id: &str) -> Result<(), PortError> {
        SqliteStore::delete_connection(self, connection_id)
    }
}

#[async_trait]
impl HistoryRepository for SqliteStore {
    async fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        SqliteStore::append_run(self, run_id, state)
    }

    async fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError> {
        SqliteStore::load_run(self, run_id)
    }
}

fn load_flow_from_connection(connection: &Connection, flow_id: &str) -> rusqlite::Result<Flow> {
    let (id, name, source_connection_id, target_connection_id, policy, version) = connection
        .query_row(
        "SELECT id, name, source_connection_id, target_connection_id, transaction_policy, version
         FROM flows WHERE id = ?1",
        [flow_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
            ))
        },
    )?;
    let mut statement = connection.prepare(
        "SELECT id, select_sql, upsert_sql FROM query_steps WHERE flow_id = ?1 ORDER BY position",
    )?;
    let query_steps = statement
        .query_map([flow_id], |row| {
            Ok(QueryStep {
                id: row.get(0)?,
                select_sql: row.get(1)?,
                upsert_sql: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Flow {
        id,
        name,
        source_connection_id,
        target_connection_id,
        query_steps,
        transaction_policy: parse_transaction_policy(&policy)?,
        version,
    })
}

fn connection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionProfile> {
    Ok(ConnectionProfile {
        id: row.get(0)?,
        display_name: row.get(1)?,
        kind: parse_db_kind(&row.get::<_, String>(2)?)?,
        host: row.get(3)?,
        port: row.get(4)?,
        service_name: row.get(5)?,
        username: row.get(6)?,
        credential_ref: row.get(7)?,
        enabled: row.get(8)?,
    })
}

fn db_kind(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Oracle => "oracle",
    }
}

fn parse_db_kind(value: &str) -> rusqlite::Result<DbKind> {
    match value {
        "oracle" => Ok(DbKind::Oracle),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn transaction_policy(policy: TransactionPolicy) -> &'static str {
    match policy {
        TransactionPolicy::AllOrNothing => "all_or_nothing",
        TransactionPolicy::CommitSuccesses => "commit_successes",
    }
}

fn parse_transaction_policy(value: &str) -> rusqlite::Result<TransactionPolicy> {
    match value {
        "all_or_nothing" => Ok(TransactionPolicy::AllOrNothing),
        "commit_successes" => Ok(TransactionPolicy::CommitSuccesses),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn recovery_action(action: RecoveryAction) -> &'static str {
    match action {
        RecoveryAction::EditAndRetry => "edit_and_retry",
        RecoveryAction::SkipAndContinue => "skip_and_continue",
        RecoveryAction::Stop => "stop",
    }
}

fn sqlite_error(_error: rusqlite::Error) -> PortError {
    PortError::new("SQLITE", "local metadata storage failed")
}

fn migrate_legacy_schema(connection: &mut Connection) -> rusqlite::Result<()> {
    let rebuild_flows = !flows_reference_connection_profiles(connection)?;
    let rebuild_recovery_events = !table_has_column(connection, "recovery_events", "sequence")?;
    if !rebuild_flows && !rebuild_recovery_events {
        return Ok(());
    }

    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let migration = (|| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if rebuild_flows {
            transaction.execute_batch(
                "
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
                    select_sql TEXT NOT NULL,
                    upsert_sql TEXT NOT NULL,
                    PRIMARY KEY (flow_id, position)
                );
                INSERT INTO flows (id, name, source_connection_id, target_connection_id, transaction_policy, version)
                    SELECT legacy.id, legacy.name, legacy.source_connection_id, legacy.target_connection_id,
                           legacy.transaction_policy, legacy.version
                    FROM flows_legacy AS legacy
                    WHERE EXISTS (SELECT 1 FROM connection_profiles WHERE id = legacy.source_connection_id)
                      AND EXISTS (SELECT 1 FROM connection_profiles WHERE id = legacy.target_connection_id);
                INSERT INTO query_steps (flow_id, position, id, select_sql, upsert_sql)
                    SELECT legacy.flow_id, legacy.position, legacy.id, legacy.select_sql, legacy.upsert_sql
                    FROM query_steps_legacy AS legacy
                    WHERE EXISTS (SELECT 1 FROM flows WHERE id = legacy.flow_id);
                DROP TABLE query_steps_legacy;
                DROP TABLE flows_legacy;
                ",
            )?;
        }
        if rebuild_recovery_events {
            transaction.execute_batch(
                "
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
                ",
            )?;
        }
        transaction.execute(
            "DELETE FROM run_steps WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = run_steps.run_id)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM recovery_events
             WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id = recovery_events.run_id)",
            [],
        )?;
        transaction.commit()
    })();
    let restore_foreign_keys = connection.pragma_update(None, "foreign_keys", "ON");
    migration?;
    restore_foreign_keys?;
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    if statement.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn migrate_legacy_run_history(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let legacy_runs = {
        let mut statement = transaction.prepare("SELECT id, state_json FROM runs")?;
        let runs = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        runs
    };

    for (run_id, state_json) in legacy_runs {
        if serde_json::from_str::<StoredRun>(&state_json).is_ok() {
            continue;
        }
        let stored = serde_json::from_str::<RunState>(&state_json)
            .map(|state| StoredRun::from_state(&state))
            .unwrap_or_else(|_| StoredRun {
                policy: TransactionPolicy::AllOrNothing,
                status: RunStatus::Failed,
                steps: Vec::new(),
                events: Vec::new(),
            });
        let sanitized_json =
            serde_json::to_string(&stored).map_err(|_| rusqlite::Error::InvalidQuery)?;
        transaction.execute(
            "UPDATE runs SET state_json = ?1 WHERE id = ?2",
            params![sanitized_json, run_id],
        )?;
    }
    transaction.commit()
}

fn flows_reference_connection_profiles(connection: &Connection) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare("PRAGMA foreign_key_list(flows)")?;
    let references = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(references.iter().any(|(table, column)| {
        table == "connection_profiles"
            && matches!(
                column.as_str(),
                "source_connection_id" | "target_connection_id"
            )
    }) && references
        .iter()
        .filter(|(table, _)| table == "connection_profiles")
        .count()
        == 2)
}

fn table_has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|column| column == column_name))
}
