use serde::Serialize;
use tauri::State;

use crate::domain::{RunStatus, StepStatus};

use super::{ApplicationContainer, CommandErrorDto};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryResponse {
    pub run_id: String,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
}

#[tauri::command]
pub async fn list_run_history(
    state: State<'_, ApplicationContainer>,
) -> Result<Vec<RunHistoryResponse>, CommandErrorDto> {
    state
        .history
        .list_runs()
        .await
        .map(|runs| {
            runs.into_iter()
                .map(|run| RunHistoryResponse {
                    run_id: run.run_id,
                    status: run.state.status(),
                    steps: run
                        .state
                        .steps()
                        .iter()
                        .map(|step| step.status.clone())
                        .collect(),
                })
                .collect()
        })
        .map_err(CommandErrorDto::from_port)
}
