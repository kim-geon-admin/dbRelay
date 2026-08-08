use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{
    application::ports::{
        BoundRecoveryApply, FlowRepository, HistoryRepository, PortError, RunBinding,
        RunHistoryEntry,
    },
    domain::{
        ConnectionProfile, CredentialStorage, DbKind, Flow, QueryStep, RecoveryAction, RunError,
        RunEvent, RunState, RunStatus, StepStatus, TransactionPolicy,
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
    #[serde(default)]
    flow_id: Option<String>,
    #[serde(default)]
    flow_version: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_stored_binding")]
    binding: Option<StoredRunBinding>,
}

/// Recovery needs to detect configuration drift, but run history must not
/// retain query text, credential references, or connection details.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
struct StoredRunBinding {
    flow_id: String,
    flow_version: u64,
    source_connection_id: String,
    source_signature: String,
    target_connection_id: String,
    target_signature: String,
}

impl From<&RunBinding> for StoredRunBinding {
    fn from(binding: &RunBinding) -> Self {
        Self {
            flow_id: binding.flow.id.clone(),
            flow_version: binding.flow.version,
            source_connection_id: binding.source_profile.id.clone(),
            source_signature: connection_signature(&binding.source_profile),
            target_connection_id: binding.target_profile.id.clone(),
            target_signature: connection_signature(&binding.target_profile),
        }
    }
}

impl StoredRunBinding {
    fn matches(&self, binding: &RunBinding) -> bool {
        self == &Self::from(binding)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredRunBindingWire {
    Safe(StoredRunBinding),
    Legacy(Box<RunBinding>),
}

fn deserialize_stored_binding<'de, D>(deserializer: D) -> Result<Option<StoredRunBinding>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<StoredRunBindingWire>::deserialize(deserializer).map(|binding| {
        binding.map(|binding| match binding {
            StoredRunBindingWire::Safe(binding) => binding,
            StoredRunBindingWire::Legacy(binding) => StoredRunBinding::from(binding.as_ref()),
        })
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
enum StoredRunEvent {
    StepSucceeded {
        step: usize,
        affected_rows: u64,
    },
    StepFailed {
        step: usize,
        error_code: String,
        #[serde(default)]
        error_message: String,
        #[serde(default)]
        retryable: bool,
    },
    TransactionFailed {
        error_code: String,
        #[serde(default)]
        error_message: String,
        #[serde(default)]
        retryable: bool,
    },
    RecoveryApplied {
        step: usize,
        action: RecoveryAction,
    },
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
            flow_id: None,
            flow_version: None,
            binding: None,
        }
        .sanitize()
    }

    fn from_bound_state(state: &RunState, binding: &RunBinding) -> Self {
        let mut stored = Self::from_state(state);
        stored.flow_id = Some(binding.flow.id.clone());
        stored.flow_version = Some(binding.flow.version);
        stored.binding = Some(StoredRunBinding::from(binding));
        stored
    }

    fn from_state_for_flow(state: &RunState, flow: &Flow) -> Self {
        let mut stored = Self::from_state(state);
        stored.flow_id = Some(flow.id.clone());
        stored.flow_version = Some(flow.version);
        stored
    }

    fn into_state(self) -> RunState {
        let events = self
            .events
            .into_iter()
            .map(StoredRunEvent::into_run_event)
            .collect();
        RunState::from_history(self.policy, self.status, self.steps, events)
    }

    fn binding(&self) -> Option<StoredRunBinding> {
        self.binding.clone()
    }

    fn sanitize(mut self) -> Self {
        if self.flow_id.is_none() {
            if let Some(binding) = &self.binding {
                self.flow_id = Some(binding.flow_id.clone());
                self.flow_version = Some(binding.flow_version);
            }
        }
        if let RunStatus::InDoubt { reason, .. } = &mut self.status {
            **reason = RunError::connector(
                reason.history_code(),
                "sanitized persisted transaction error",
            );
        }
        for event in &mut self.events {
            match event {
                StoredRunEvent::StepFailed {
                    error_code,
                    error_message,
                    ..
                }
                | StoredRunEvent::TransactionFailed {
                    error_code,
                    error_message,
                    ..
                } => {
                    *error_code =
                        RunError::connector(std::mem::take(error_code), "").history_code();
                    *error_message = sanitize_history_message(error_message);
                }
                StoredRunEvent::StepSucceeded { .. } | StoredRunEvent::RecoveryApplied { .. } => {}
            }
        }
        self
    }

    fn normalize_interrupted_recovery(mut self) -> Self {
        self.status = match self.status {
            RunStatus::RecoveryPending { failed_step, .. } => {
                RunStatus::AwaitingRecovery { failed_step }
            }
            RunStatus::CommitPending { step } => RunStatus::InDoubt {
                step,
                reason: Box::new(RunError::connector(
                    "COMMIT_OUTCOME_UNKNOWN",
                    "commit outcome could not be confirmed",
                )),
            },
            status => status,
        };
        self.sanitize()
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
                error_message: safe_history_message(error),
                retryable: error.retryable(),
            },
            RunEvent::TransactionFailed { error } => Self::TransactionFailed {
                error_code: error.history_code(),
                error_message: safe_history_message(error),
                retryable: error.retryable(),
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
            Self::StepFailed {
                step,
                error_code,
                error_message,
                retryable,
            } => RunEvent::StepFailed {
                step,
                error: RunError::connector_with_retryable(
                    error_code,
                    sanitize_history_message(&error_message),
                    retryable,
                ),
            },
            Self::TransactionFailed {
                error_code,
                error_message,
                retryable,
            } => RunEvent::TransactionFailed {
                error: RunError::connector_with_retryable(
                    error_code,
                    sanitize_history_message(&error_message),
                    retryable,
                ),
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
                ",
        )
            .map_err(sqlite_error)?;
        migrate_legacy_schema(&mut connection).map_err(sqlite_error)?;
        migrate_run_history_columns(&mut connection).map_err(sqlite_error)?;
        migrate_legacy_run_history(&mut connection).map_err(sqlite_error)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO connection_profiles
                    (id, display_name, kind, host, port, service_name, username, credential_ref, credential_storage, plaintext_password, enabled, source_read_only)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                    source_read_only = excluded.source_read_only",
                params![
                    profile.id,
                    profile.display_name,
                    db_kind(profile.kind),
                    profile.host,
                    profile.port,
                    profile.sid,
                    profile.username,
                    profile.credential_ref,
                    credential_storage(profile.credential_storage),
                    profile.plaintext_password,
                    profile.enabled as i64,
                    profile.source_read_only as i64,
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
                "SELECT id, display_name, kind, host, port, service_name, username, credential_ref, credential_storage, plaintext_password, enabled, source_read_only
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
        self.with_connection_port(|connection| {
            let transaction = connection.transaction().map_err(sqlite_error)?;
            let current_version = transaction
                .query_row("SELECT version FROM flows WHERE id = ?1", [&flow.id], |row| {
                    row.get::<_, u64>(0)
                })
                .optional()
                .map_err(sqlite_error)?;
            let next_version = match current_version {
                // Ordinary saves supply the version the client observed. The
                // database advances it atomically after the comparison.
                Some(version) if version == flow.version => version.checked_add(1).ok_or_else(|| {
                    PortError::new("FLOW_VERSION_INVALID", "flow version cannot be advanced")
                })?,
                Some(_) => {
                    return Err(PortError::new(
                        "FLOW_VERSION_CONFLICT",
                        "flow was changed by another save",
                    ))
                }
                None => 1,
            };
            transaction
                .execute(
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
                        next_version,
                    ],
                )
                .map_err(sqlite_error)?;
            replace_flow_steps(&transaction, flow).map_err(sqlite_error)?;
            transaction.commit().map_err(sqlite_error)?;
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
        self.append_stored_run(run_id, state, StoredRun::from_state(state))
    }

    pub fn append_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        self.append_stored_run(run_id, state, StoredRun::from_bound_state(state, binding))
    }

    pub fn create_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        self.create_stored_run(run_id, state, StoredRun::from_state(state))
    }

    pub fn create_run_for_flow(
        &self,
        run_id: &str,
        state: &RunState,
        flow: &Flow,
    ) -> Result<(), PortError> {
        self.create_stored_run(run_id, state, StoredRun::from_state_for_flow(state, flow))
    }

    pub fn create_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        self.create_stored_run(run_id, state, StoredRun::from_bound_state(state, binding))
    }

    fn append_stored_run(
        &self,
        run_id: &str,
        state: &RunState,
        stored_run: StoredRun,
    ) -> Result<(), PortError> {
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
            write_stored_run(
                &transaction,
                run_id,
                state_json,
                &step_statuses,
                state,
                false,
            )?;
            transaction.commit()?;
            Ok(())
        })
    }

    fn create_stored_run(
        &self,
        run_id: &str,
        state: &RunState,
        stored_run: StoredRun,
    ) -> Result<(), PortError> {
        let (state_json, step_statuses) = serialize_stored_run(state, stored_run)?;
        self.with_connection_port(|connection| {
            let transaction = connection.transaction().map_err(sqlite_error)?;
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM runs WHERE id = ?1)",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(sqlite_error)?;
            if exists {
                return Err(PortError::new(
                    "RUN_ID_COLLISION",
                    "run ID is already in use",
                ));
            }
            write_stored_run(
                &transaction,
                run_id,
                state_json,
                &step_statuses,
                state,
                true,
            )
            .map_err(sqlite_error)?;
            transaction.commit().map_err(sqlite_error)?;
            Ok(())
        })
    }

    pub fn apply_bound_recovery(
        &self,
        run_id: &str,
        state: &RunState,
        expected_state: &RunState,
        expected_binding: &RunBinding,
        persisted_binding: &RunBinding,
        updated_flow: Option<&Flow>,
    ) -> Result<BoundRecoveryApply, PortError> {
        let stored_run = StoredRun::from_bound_state(state, persisted_binding);
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
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current_run_json: Option<String> = transaction
                .query_row(
                    "SELECT state_json FROM runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(current_run_json) = current_run_json else {
                return Ok(BoundRecoveryApply::RecoveryNoLongerAvailable);
            };
            let current_run = serde_json::from_str::<StoredRun>(&current_run_json)
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            let current_binding = current_run.binding();
            let current_state = current_run.into_state();
            if current_state != *expected_state
                || !matches!(
                    current_state.status(),
                    RunStatus::AwaitingRecovery { .. } | RunStatus::RecoveryPending { .. }
                )
                || !current_binding
                    .as_ref()
                    .is_some_and(|binding| binding.matches(expected_binding))
            {
                return Ok(BoundRecoveryApply::RecoveryNoLongerAvailable);
            }
            let flow_exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM flows WHERE id = ?1)",
                [&expected_binding.flow.id],
                |row| row.get(0),
            )?;
            let current_flow = flow_exists
                .then(|| load_flow_from_connection(&transaction, &expected_binding.flow.id))
                .transpose()?;
            let source_profile =
                load_connection_from_connection(&transaction, &expected_binding.source_profile.id)?;
            let target_profile =
                load_connection_from_connection(&transaction, &expected_binding.target_profile.id)?;
            if current_flow.as_ref() != Some(&expected_binding.flow)
                || source_profile.as_ref() != Some(&expected_binding.source_profile)
                || target_profile.as_ref() != Some(&expected_binding.target_profile)
            {
                return Ok(BoundRecoveryApply::ConfigurationChanged);
            }
            if let Some(flow) = updated_flow {
                if flow.version != expected_binding.flow.version.saturating_add(1) {
                    return Ok(BoundRecoveryApply::ConfigurationChanged);
                }
                let changed = transaction.execute(
                    "UPDATE flows SET
                        name = ?2,
                        source_connection_id = ?3,
                        target_connection_id = ?4,
                        transaction_policy = ?5,
                        version = ?6
                     WHERE id = ?1 AND version = ?7",
                    params![
                        flow.id,
                        flow.name,
                        flow.source_connection_id,
                        flow.target_connection_id,
                        transaction_policy(flow.transaction_policy),
                        flow.version,
                        expected_binding.flow.version,
                    ],
                )?;
                if changed != 1 {
                    return Ok(BoundRecoveryApply::ConfigurationChanged);
                }
                replace_flow_steps(&transaction, flow)?;
            }
            write_stored_run(
                &transaction,
                run_id,
                state_json,
                &step_statuses,
                state,
                false,
            )?;
            transaction.commit()?;
            Ok(BoundRecoveryApply::Applied)
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

    pub fn list_runs(&self) -> Result<Vec<RunHistoryEntry>, PortError> {
        let runs: Vec<(String, String, u64, Option<u64>)> = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, state_json, started_at_ms, ended_at_ms FROM runs ORDER BY id DESC",
            )?;
            let runs = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect();
            runs
        })?;

        runs.into_iter()
            .map(|(run_id, state_json, started_at_ms, ended_at_ms)| {
                serde_json::from_str::<StoredRun>(&state_json)
                    .map(|stored| RunHistoryEntry {
                        run_id,
                        flow_id: stored.flow_id.clone(),
                        flow_version: stored.flow_version,
                        started_at_ms,
                        ended_at_ms,
                        state: stored.into_state(),
                    })
                    .map_err(|_| {
                        PortError::new("HISTORY_DESERIALIZATION", "run history could not be loaded")
                    })
            })
            .collect()
    }

    pub fn load_run_binding(&self, run_id: &str) -> Result<Option<RunBinding>, PortError> {
        self.with_connection_port(|connection| {
            let state_json: Option<String> = connection
                .query_row(
                    "SELECT state_json FROM runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sqlite_error)?;
            let Some(state_json) = state_json else {
                return Ok(None);
            };
            let binding = serde_json::from_str::<StoredRun>(&state_json)
                .map_err(|_| {
                    PortError::new("HISTORY_DESERIALIZATION", "run history could not be loaded")
                })?
                .binding();
            let Some(binding) = binding else {
                return Ok(None);
            };
            let flow =
                load_flow_from_connection(connection, &binding.flow_id).map_err(sqlite_error)?;
            let source_profile =
                load_connection_from_connection(connection, &binding.source_connection_id)
                    .map_err(sqlite_error)?;
            let target_profile =
                load_connection_from_connection(connection, &binding.target_connection_id)
                    .map_err(sqlite_error)?;
            let (Some(source_profile), Some(target_profile)) = (source_profile, target_profile)
            else {
                return Ok(None);
            };
            let current = RunBinding {
                flow,
                source_profile,
                target_profile,
            };
            Ok(binding.matches(&current).then_some(current))
        })
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

    #[doc(hidden)]
    pub fn run_history_json_for_test(&self, run_id: &str) -> Option<String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT state_json FROM runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()
        })
        .ok()
        .flatten()
    }

    fn load_connection_optional(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, display_name, kind, host, port, service_name, username, credential_ref, credential_storage, plaintext_password, enabled, source_read_only
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

    fn with_connection_port<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, PortError>,
    ) -> Result<T, PortError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| PortError::new("SQLITE_LOCK", "local database lock is unavailable"))?;
        operation(&mut connection)
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
        SqliteStore::save_connection(self, profile)
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
    async fn create_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        SqliteStore::create_run(self, run_id, state)
    }

    async fn create_run_for_flow(
        &self,
        run_id: &str,
        state: &RunState,
        flow: &Flow,
    ) -> Result<(), PortError> {
        SqliteStore::create_run_for_flow(self, run_id, state, flow)
    }

    async fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        SqliteStore::append_run(self, run_id, state)
    }

    async fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError> {
        SqliteStore::load_run(self, run_id)
    }

    async fn list_runs(&self) -> Result<Vec<RunHistoryEntry>, PortError> {
        SqliteStore::list_runs(self)
    }

    async fn append_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        SqliteStore::append_bound_run(self, run_id, state, binding)
    }

    async fn create_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        SqliteStore::create_bound_run(self, run_id, state, binding)
    }

    async fn load_run_binding(&self, run_id: &str) -> Result<Option<RunBinding>, PortError> {
        SqliteStore::load_run_binding(self, run_id)
    }

    async fn apply_bound_recovery(
        &self,
        run_id: &str,
        state: &RunState,
        expected_state: &RunState,
        expected_binding: &RunBinding,
        persisted_binding: &RunBinding,
        updated_flow: Option<&Flow>,
    ) -> Result<BoundRecoveryApply, PortError> {
        SqliteStore::apply_bound_recovery(
            self,
            run_id,
            state,
            expected_state,
            expected_binding,
            persisted_binding,
            updated_flow,
        )
    }
}

fn write_stored_run(
    transaction: &rusqlite::Transaction<'_>,
    run_id: &str,
    state_json: String,
    step_statuses: &[(usize, String)],
    state: &RunState,
    insert_only: bool,
) -> rusqlite::Result<()> {
    if insert_only {
        transaction.execute(
            "INSERT INTO runs (id, state_json, started_at_ms, ended_at_ms)
             VALUES (?1, ?2, ?3, CASE WHEN ?4 THEN ?3 ELSE NULL END)",
            params![
                run_id,
                state_json,
                now_unix_ms(),
                is_terminal_run(state.status())
            ],
        )?;
    } else {
        transaction.execute(
            "INSERT INTO runs (id, state_json, started_at_ms, ended_at_ms)
             VALUES (?1, ?2, ?3, CASE WHEN ?4 THEN ?3 ELSE NULL END)
             ON CONFLICT(id) DO UPDATE SET
               state_json = excluded.state_json,
               ended_at_ms = CASE
                 WHEN runs.ended_at_ms IS NULL AND ?4 THEN ?3
                 ELSE runs.ended_at_ms
               END",
            params![
                run_id,
                state_json,
                now_unix_ms(),
                is_terminal_run(state.status())
            ],
        )?;
    }
    transaction.execute("DELETE FROM run_steps WHERE run_id = ?1", [run_id])?;
    transaction.execute("DELETE FROM recovery_events WHERE run_id = ?1", [run_id])?;
    for (position, status_json) in step_statuses {
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
    Ok(())
}

fn serialize_stored_run(
    state: &RunState,
    stored_run: StoredRun,
) -> Result<(String, Vec<(usize, String)>), PortError> {
    let state_json = serde_json::to_string(&stored_run)
        .map_err(|_| PortError::new("HISTORY_SERIALIZATION", "run history could not be saved"))?;
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
    Ok((state_json, step_statuses))
}

fn replace_flow_steps(
    transaction: &rusqlite::Transaction<'_>,
    flow: &Flow,
) -> rusqlite::Result<()> {
    transaction.execute("DELETE FROM query_steps WHERE flow_id = ?1", [&flow.id])?;
    for (position, step) in flow.query_steps.iter().enumerate() {
        transaction.execute(
            "INSERT INTO query_steps (flow_id, position, id, select_sql, upsert_sql)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                flow.id,
                position as i64,
                step.id,
                step.select_sql,
                step.upsert_sql
            ],
        )?;
    }
    Ok(())
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

fn load_connection_from_connection(
    connection: &Connection,
    connection_id: &str,
) -> rusqlite::Result<Option<ConnectionProfile>> {
    connection
        .query_row(
            "SELECT id, display_name, kind, host, port, service_name, username, credential_ref, credential_storage, plaintext_password, enabled, source_read_only
             FROM connection_profiles WHERE id = ?1",
            [connection_id],
            connection_from_row,
        )
        .optional()
}

fn connection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionProfile> {
    Ok(ConnectionProfile {
        id: row.get(0)?,
        display_name: row.get(1)?,
        kind: parse_db_kind(&row.get::<_, String>(2)?)?,
        host: row.get(3)?,
        port: row.get(4)?,
        sid: row.get(5)?,
        username: row.get(6)?,
        credential_ref: row.get(7)?,
        credential_storage: parse_credential_storage(&row.get::<_, String>(8)?)?,
        plaintext_password: row.get(9)?,
        enabled: row.get(10)?,
        source_read_only: row.get(11)?,
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

fn credential_storage(storage: CredentialStorage) -> &'static str {
    match storage {
        CredentialStorage::Keyring => "keyring",
        CredentialStorage::Plaintext => "plaintext",
    }
}

fn parse_credential_storage(value: &str) -> rusqlite::Result<CredentialStorage> {
    match value {
        "keyring" => Ok(CredentialStorage::Keyring),
        "plaintext" => Ok(CredentialStorage::Plaintext),
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

fn connection_signature(profile: &ConnectionProfile) -> String {
    // Stable FNV-1a is used only as an equality fingerprint for recovery;
    // it is never presented as authentication or persisted source metadata.
    let material = format!(
        "{:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        profile.kind,
        profile.host,
        profile.port,
        profile.sid,
        profile.username,
        profile.enabled
    );
    let hash = material
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

fn safe_history_message(error: &RunError) -> String {
    error
        .connector_message()
        .map(sanitize_history_message)
        .unwrap_or_else(|| "sanitized persisted run error".into())
}

fn sanitize_history_message(message: &str) -> String {
    let message = crate::domain::mask_sensitive_text(message);
    let lower = message.to_ascii_lowercase();
    let unsafe_content = [
        "select",
        "insert",
        "update",
        "delete",
        "merge",
        "begin",
        "declare",
        "password",
        "secret",
        "token",
        "credential",
        "bind",
        "row",
        ":",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if message.is_empty()
        || unsafe_content
        || message.len() > 512
        || !message
            .chars()
            .all(|character| character.is_ascii_graphic() || character == ' ')
    {
        "sanitized persisted run error".into()
    } else {
        message
    }
}

fn sqlite_error(_error: rusqlite::Error) -> PortError {
    PortError::new("SQLITE", "local metadata storage failed")
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_terminal_run(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed
            | RunStatus::RolledBack
            | RunStatus::StoppedByUser
            | RunStatus::Failed
            | RunStatus::InDoubt { .. }
    )
}

fn migrate_run_history_columns(connection: &mut Connection) -> rusqlite::Result<()> {
    if !table_has_column(connection, "connection_profiles", "source_read_only")? {
        connection.execute(
            "ALTER TABLE connection_profiles ADD COLUMN source_read_only INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !table_has_column(connection, "connection_profiles", "credential_storage")? {
        connection.execute(
            "ALTER TABLE connection_profiles ADD COLUMN credential_storage TEXT NOT NULL DEFAULT 'keyring'",
            [],
        )?;
    }
    if !table_has_column(connection, "connection_profiles", "plaintext_password")? {
        connection.execute(
            "ALTER TABLE connection_profiles ADD COLUMN plaintext_password TEXT",
            [],
        )?;
    }
    if !table_has_column(connection, "runs", "started_at_ms")? {
        connection.execute(
            "ALTER TABLE runs ADD COLUMN started_at_ms INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !table_has_column(connection, "runs", "ended_at_ms")? {
        connection.execute("ALTER TABLE runs ADD COLUMN ended_at_ms INTEGER", [])?;
    }
    Ok(())
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
        let stored = serde_json::from_str::<StoredRun>(&state_json)
            .or_else(|_| {
                serde_json::from_str::<RunState>(&state_json)
                    .map(|state| StoredRun::from_state(&state))
            })
            .unwrap_or_else(|_| StoredRun {
                policy: TransactionPolicy::AllOrNothing,
                status: RunStatus::Failed,
                steps: Vec::new(),
                events: Vec::new(),
                flow_id: None,
                flow_version: None,
                binding: None,
            })
            .sanitize()
            .normalize_interrupted_recovery();
        let sanitized_json =
            serde_json::to_string(&stored).map_err(|_| rusqlite::Error::InvalidQuery)?;
        transaction.execute(
            "UPDATE runs SET state_json = ?1,
                ended_at_ms = CASE
                  WHEN ended_at_ms IS NULL AND ?2 THEN ?3
                  ELSE ended_at_ms
                END
             WHERE id = ?4",
            params![
                sanitized_json,
                is_terminal_run(stored.status.clone()),
                now_unix_ms(),
                run_id
            ],
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
