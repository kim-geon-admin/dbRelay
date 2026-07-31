use std::time::SystemTime;

use async_trait::async_trait;

use crate::domain::{ConnectionProfile, DbKind, Flow, NamedRow, RowSet, RunState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortError {
    code: String,
    message: String,
}

impl PortError {
    pub fn new(code: impl Into<String>, message: impl AsRef<str>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(message.as_ref()),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
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
pub struct ResolvedSecret(String);

impl ResolvedSecret {
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[allow(dead_code)] // Consumed by the concrete connector introduced in Task 8.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    pub(crate) fn into_inner(self) -> String {
        self.0
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
    async fn store(&self, credential_ref: &str, secret: ResolvedSecret) -> Result<(), PortError>;
    async fn resolve(&self, credential_ref: &str) -> Result<ResolvedSecret, PortError>;
    async fn delete(&self, credential_ref: &str) -> Result<(), PortError>;
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
    async fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError>;
    async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError>;
}

#[async_trait]
pub trait HistoryRepository: Send + Sync {
    async fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError>;
    async fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}
