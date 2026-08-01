use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    application::migration_runner::{
        MigrationRunner, RecoveryError, RecoveryRequest, RunSnapshot, StartRunError,
    },
    domain::{RunStatus, StepStatus},
};

use super::{ApplicationContainer, CommandErrorDto};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub flow_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RecoverRunRequest {
    EditAndRetry {
        run_id: String,
        step_id: String,
        select_sql: String,
        upsert_sql: String,
    },
    SkipAndContinue {
        run_id: String,
        step_id: String,
    },
    Stop {
        run_id: String,
        step_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub run_id: String,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
}

impl From<RunSnapshot> for RunResponse {
    fn from(snapshot: RunSnapshot) -> Self {
        Self {
            run_id: snapshot.run_id,
            status: snapshot.status,
            steps: snapshot.steps,
        }
    }
}

#[tauri::command]
pub async fn start_run(
    request: StartRunRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<RunResponse, CommandErrorDto> {
    validate_required(&request.flow_id, "flow ID")?;
    let runner = runner(&state);
    runner
        .start(&request.flow_id)
        .await
        .map(RunResponse::from)
        .map_err(CommandErrorDto::from_start)
}

#[tauri::command]
pub async fn recover_run(
    request: RecoverRunRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<RunResponse, CommandErrorDto> {
    let (run_id, step_id, recovery) = request.into_recovery()?;
    let runner = runner(&state);
    runner
        .recover(&run_id, recovery)
        .await
        .map(RunResponse::from)
        .map_err(|error| CommandErrorDto::from_recovery(error, run_id, Some(step_id)))
}

fn runner(
    state: &State<'_, ApplicationContainer>,
) -> MigrationRunner<
    dyn crate::application::ports::DatabaseConnectorFactory,
    dyn crate::application::ports::FlowRepository,
    dyn crate::application::ports::HistoryRepository,
    dyn crate::application::ports::CredentialStore,
    dyn crate::application::ports::Clock,
> {
    MigrationRunner::new(
        state.connector.clone(),
        state.repository.clone(),
        state.history.clone(),
        state.credentials.clone(),
        state.clock.clone(),
    )
}

impl RecoverRunRequest {
    fn into_recovery(self) -> Result<(String, String, RecoveryRequest), CommandErrorDto> {
        match self {
            Self::EditAndRetry {
                run_id,
                step_id,
                select_sql,
                upsert_sql,
            } => {
                validate_required(&run_id, "run ID")?;
                validate_required(&step_id, "step ID")?;
                validate_required(&select_sql, "source SQL")?;
                validate_required(&upsert_sql, "target SQL")?;
                Ok((
                    run_id,
                    step_id.clone(),
                    RecoveryRequest::EditAndRetry {
                        step_id,
                        select_sql,
                        upsert_sql,
                    },
                ))
            }
            Self::SkipAndContinue { run_id, step_id } => {
                validate_required(&run_id, "run ID")?;
                validate_required(&step_id, "step ID")?;
                Ok((
                    run_id,
                    step_id.clone(),
                    RecoveryRequest::SkipAndContinue { step_id },
                ))
            }
            Self::Stop { run_id, step_id } => {
                validate_required(&run_id, "run ID")?;
                validate_required(&step_id, "step ID")?;
                Ok((run_id, step_id.clone(), RecoveryRequest::Stop { step_id }))
            }
        }
    }
}

impl CommandErrorDto {
    fn from_start(error: StartRunError) -> Self {
        Self::from_run_error(error.code(), error.message(), "", None)
    }

    fn from_recovery(error: RecoveryError, run_id: String, step_id: Option<String>) -> Self {
        Self::from_run_error(error.code(), error.message(), run_id, step_id)
    }
}

fn validate_required(value: &str, label: &str) -> Result<(), CommandErrorDto> {
    if value.trim().is_empty() {
        return Err(CommandErrorDto::validation(format!("{label} is required")));
    }
    Ok(())
}
