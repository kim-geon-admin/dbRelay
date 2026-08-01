use std::{path::Path, sync::Arc, time::SystemTime};

use serde::Serialize;

use crate::{
    application::ports::{
        Clock, CredentialStore, DatabaseConnectorFactory, FlowRepository, HistoryRepository,
        PortError,
    },
    connectors::OracleConnector,
    domain::mask_sensitive_text,
    infrastructure::{credentials::KeyringCredentialStore, sqlite::SqliteStore},
};

pub mod connections;
pub mod flows;
pub mod history;
pub mod runs;

pub use connections::{
    disable_connection, list_connections, save_connection, test_connection, update_connection,
    ConnectionIdRequest, ConnectionRequest, ConnectionResponse, TestConnectionResponse,
    UpdateConnectionRequest,
};
pub use flows::{
    duplicate_flow, list_flows, save_flow, DuplicateFlowRequest, FlowRequest, FlowResponse,
    QueryStepRequest,
};
pub use history::{list_run_history, RunHistoryResponse};
pub use runs::{recover_run, start_run, RecoverRunRequest, RunResponse, StartRunRequest};

/// The single managed application boundary used by every desktop command.
pub struct ApplicationContainer {
    pub(crate) repository: Arc<dyn FlowRepository>,
    pub(crate) history: Arc<dyn HistoryRepository>,
    pub(crate) credentials: Arc<dyn CredentialStore>,
    pub(crate) connector: Arc<dyn DatabaseConnectorFactory>,
    pub(crate) clock: Arc<dyn Clock>,
}

impl ApplicationContainer {
    pub fn new(
        repository: Arc<dyn FlowRepository>,
        history: Arc<dyn HistoryRepository>,
        credentials: Arc<dyn CredentialStore>,
        connector: Arc<dyn DatabaseConnectorFactory>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            repository,
            history,
            credentials,
            connector,
            clock,
        }
    }

    pub fn for_desktop(app_data_dir: impl AsRef<Path>) -> Result<Self, PortError> {
        let app_data_dir = app_data_dir.as_ref();
        if !app_data_dir.is_absolute() {
            return Err(PortError::new(
                "APP_DATA_PATH",
                "application data directory must be absolute",
            ));
        }
        std::fs::create_dir_all(app_data_dir).map_err(|_| {
            PortError::new("APP_DATA_PATH", "application data directory is unavailable")
        })?;
        let app_data_dir = app_data_dir.canonicalize().map_err(|_| {
            PortError::new("APP_DATA_PATH", "application data directory is unavailable")
        })?;
        let store = Arc::new(SqliteStore::open(app_data_dir.join("db-relay.sqlite"))?);
        let repository: Arc<dyn FlowRepository> = store.clone();
        let history: Arc<dyn HistoryRepository> = store;

        Ok(Self::new(
            repository,
            history,
            Arc::new(KeyringCredentialStore::new()),
            Arc::new(OracleConnector::default()),
            Arc::new(SystemClock),
        ))
    }
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandErrorDto {
    pub title: String,
    pub detail: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
}

impl CommandErrorDto {
    pub(crate) fn validation(detail: impl AsRef<str>) -> Self {
        Self::new("INVALID_REQUEST", "Invalid request", detail, None, None)
    }

    pub(crate) fn from_port(error: PortError) -> Self {
        let code = error.code().to_owned();
        Self::new(code.clone(), title_for(&code), error.message(), None, None)
    }

    pub(crate) fn from_run_error(
        code: impl Into<String>,
        detail: impl AsRef<str>,
        run_id: impl Into<String>,
        step_id: Option<String>,
    ) -> Self {
        let code = code.into();
        let run_id = run_id.into();
        Self::new(
            code.clone(),
            title_for(&code),
            detail,
            (!run_id.is_empty()).then_some(run_id),
            step_id,
        )
    }

    fn new(
        code: impl Into<String>,
        title: impl Into<String>,
        detail: impl AsRef<str>,
        run_id: Option<String>,
        step_id: Option<String>,
    ) -> Self {
        Self {
            title: title.into(),
            detail: mask_sensitive_text(detail.as_ref()),
            code: code.into(),
            run_id,
            step_id,
        }
    }
}

fn title_for(code: &str) -> &'static str {
    match code {
        "CONNECTION_NOT_FOUND" => "Connection not found",
        "CONNECTION_DISABLED" => "Connection is disabled",
        "CREDENTIAL_NOT_FOUND" | "CREDENTIAL_STORE" => "Credentials unavailable",
        "FLOW_NOT_FOUND" => "Flow not found",
        "RUN_NOT_FOUND" => "Run not found",
        "RECOVERY_NOT_AVAILABLE" => "Recovery is unavailable",
        "RECOVERY_CONFIG_MISMATCH" => "Run configuration changed",
        _ => "Request could not be completed",
    }
}
