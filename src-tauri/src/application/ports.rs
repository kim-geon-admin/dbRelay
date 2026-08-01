use std::time::SystemTime;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::domain::{ConnectionProfile, DbKind, Flow, NamedRow, RowSet, RunState};

/// Immutable flow and connection configuration associated with a migration run.
///
/// This contains connection metadata but never resolved credential material.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunBinding {
    pub flow: Flow,
    pub source_profile: ConnectionProfile,
    pub target_profile: ConnectionProfile,
}

/// A persisted run with its opaque state. Command DTOs must project this into
/// a safe summary rather than serializing the binding or event payloads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunHistoryEntry {
    pub run_id: String,
    pub flow_id: Option<String>,
    pub flow_version: Option<u64>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub state: RunState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundRecoveryApply {
    Applied,
    ConfigurationChanged,
    RecoveryNoLongerAvailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortError {
    code: String,
    message: String,
    retryable: bool,
}

impl PortError {
    pub fn new(code: impl Into<String>, message: impl AsRef<str>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(message.as_ref()),
            retryable: false,
        }
    }

    pub fn with_retryable(
        code: impl Into<String>,
        message: impl AsRef<str>,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(message.as_ref()),
            retryable,
        }
    }

    pub fn with_credential_values(
        code: impl Into<String>,
        message: impl AsRef<str>,
        retryable: bool,
        credential_values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        let credential_values = credential_values
            .into_iter()
            .map(Into::into)
            .collect::<Vec<_>>();
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text_with_values(
                message.as_ref(),
                &credential_values,
            ),
            retryable,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retryable(&self) -> bool {
        self.retryable
    }
}

impl std::fmt::Display for PortError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PortError {}

/// Credential material resolved immediately before a connector is opened.
///
/// The inner value is intentionally inaccessible outside this crate so ports
/// cannot accidentally serialize, log, or return it through a command DTO.
#[derive(Clone)]
pub struct ResolvedSecret(std::sync::Arc<str>);

impl ResolvedSecret {
    #[allow(dead_code)] // Consumed by the credential implementation introduced in Task 5.
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into().into())
    }

    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn for_test(value: impl Into<String>) -> Self {
        Self::new(value)
    }

    #[allow(dead_code)] // Consumed by the concrete connector introduced in Task 8.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

#[async_trait]
pub trait DatabaseConnectorFactory: Send + Sync {
    fn kind(&self) -> DbKind;

    /// Opens a new, isolated session for one source or target connection.
    async fn open(
        &self,
        profile: &ConnectionProfile,
        secret: &ResolvedSecret,
    ) -> Result<Box<dyn DatabaseSession>, PortError>;
}

#[async_trait]
pub trait DatabaseSession: Send {
    async fn query(&mut self, sql: &str) -> Result<RowSet, PortError>;
    async fn begin(&mut self) -> Result<(), PortError>;
    async fn execute_named(&mut self, sql: &str, batch: &[NamedRow]) -> Result<u64, PortError>;
    async fn commit(&mut self) -> Result<(), PortError>;
    async fn rollback(&mut self) -> Result<(), PortError>;
}

#[async_trait]
pub trait CredentialStore: Send + Sync {
    /// Uses the stable connection ID as the credential-manager account name.
    async fn store(&self, connection_id: &str, secret: ResolvedSecret) -> Result<(), PortError>;
    async fn resolve(&self, connection_id: &str) -> Result<ResolvedSecret, PortError>;
    async fn delete(&self, connection_id: &str) -> Result<(), PortError>;
}

#[async_trait]
pub trait FlowRepository: Send + Sync {
    async fn load_flow(&self, flow_id: &str) -> Result<Option<Flow>, PortError>;
    async fn save_flow(&self, flow: &Flow) -> Result<(), PortError>;
    async fn list_flows(&self) -> Result<Vec<Flow>, PortError>;

    async fn load_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError>;
    async fn load_runnable_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        let profile = self.load_connection(connection_id).await?;
        if profile.as_ref().is_some_and(|profile| !profile.enabled) {
            return Err(PortError::new(
                "CONNECTION_DISABLED",
                "connection is disabled",
            ));
        }
        Ok(profile)
    }
    async fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError>;
    async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError>;
    async fn update_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError>;
    async fn disable_connection(&self, connection_id: &str) -> Result<(), PortError>;
    async fn delete_connection(&self, connection_id: &str) -> Result<(), PortError>;
}

#[async_trait]
pub trait HistoryRepository: Send + Sync {
    /// Creates the first history record for a run. Production repositories
    /// must reject an existing ID rather than overwriting its history.
    async fn create_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        self.append_run(run_id, state).await
    }
    /// Creates an initial preflight record with the safe flow audit identity.
    async fn create_run_for_flow(
        &self,
        run_id: &str,
        state: &RunState,
        _flow: &Flow,
    ) -> Result<(), PortError> {
        self.create_run(run_id, state).await
    }
    async fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError>;
    async fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError>;
    async fn list_runs(&self) -> Result<Vec<RunHistoryEntry>, PortError> {
        Err(PortError::new(
            "HISTORY_LIST_UNAVAILABLE",
            "run history listing is unavailable",
        ))
    }
    async fn append_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError>;
    /// Creates the first bound history record for a run without allowing a
    /// collision to replace another invocation's persisted configuration.
    async fn create_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        self.append_bound_run(run_id, state, binding).await
    }
    async fn load_run_binding(&self, run_id: &str) -> Result<Option<RunBinding>, PortError>;
    async fn apply_bound_recovery(
        &self,
        run_id: &str,
        state: &RunState,
        expected_state: &RunState,
        expected_binding: &RunBinding,
        persisted_binding: &RunBinding,
        updated_flow: Option<&Flow>,
    ) -> Result<BoundRecoveryApply, PortError>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}
