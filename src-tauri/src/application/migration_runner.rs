use std::{sync::Arc, time::UNIX_EPOCH};

use crate::{
    application::ports::{
        Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession, FlowRepository,
        HistoryRepository, PortError, ResolvedSecret,
    },
    domain::{
        extract_named_binds, map_row, ConnectionProfile, Flow, RunError, RunEvent, RunState,
        RunStatus, StepStatus, TransactionPolicy,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
}

impl RunSnapshot {
    fn from_state(run_id: String, state: &RunState) -> Self {
        Self {
            run_id,
            status: state.status(),
            steps: state
                .steps()
                .iter()
                .map(|step| step.status.clone())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartRunError {
    code: String,
    message: String,
}

impl StartRunError {
    fn from_port(error: PortError) -> Self {
        Self {
            code: error.code().into(),
            message: error.message().into(),
        }
    }

    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(&message.into()),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for StartRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StartRunError {}

pub struct MigrationRunner<
    D: DatabaseConnectorFactory + ?Sized,
    F: FlowRepository + ?Sized,
    H: HistoryRepository + ?Sized,
    C: CredentialStore + ?Sized,
    K: Clock + ?Sized,
> {
    connector: Arc<D>,
    flows: Arc<F>,
    history: Arc<H>,
    credentials: Arc<C>,
    clock: Arc<K>,
}

impl<
        D: DatabaseConnectorFactory + ?Sized,
        F: FlowRepository + ?Sized,
        H: HistoryRepository + ?Sized,
        C: CredentialStore + ?Sized,
        K: Clock + ?Sized,
    > MigrationRunner<D, F, H, C, K>
{
    pub fn new(
        connector: Arc<D>,
        flows: Arc<F>,
        history: Arc<H>,
        credentials: Arc<C>,
        clock: Arc<K>,
    ) -> Self {
        Self {
            connector,
            flows,
            history,
            credentials,
            clock,
        }
    }

    pub async fn start(&self, flow_id: &str) -> Result<RunSnapshot, StartRunError> {
        let flow = self
            .flows
            .load_flow(flow_id)
            .await
            .map_err(StartRunError::from_port)?
            .ok_or_else(|| StartRunError::new("FLOW_NOT_FOUND", "flow not found"))?;
        let run_id = self.run_id(&flow);

        if flow.transaction_policy != TransactionPolicy::AllOrNothing {
            return self
                .persist_preflight_failure(
                    &flow,
                    &run_id,
                    0,
                    RunError::connector(
                        "POLICY_NOT_SUPPORTED",
                        "this runner currently supports all-or-nothing flows",
                    ),
                )
                .await;
        }

        let source_profile = match self
            .flows
            .load_runnable_connection(&flow.source_connection_id)
            .await
        {
            Ok(Some(profile)) => profile,
            Ok(None) => {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        0,
                        RunError::connector(
                            "CONNECTION_NOT_FOUND",
                            "source connection was not found",
                        ),
                    )
                    .await
            }
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let target_profile = match self
            .flows
            .load_runnable_connection(&flow.target_connection_id)
            .await
        {
            Ok(Some(profile)) => profile,
            Ok(None) => {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        0,
                        RunError::connector(
                            "CONNECTION_NOT_FOUND",
                            "target connection was not found",
                        ),
                    )
                    .await
            }
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        if source_profile.kind != self.connector.kind()
            || target_profile.kind != self.connector.kind()
        {
            return self
                .persist_preflight_failure(
                    &flow,
                    &run_id,
                    0,
                    RunError::connector("CONNECTOR_KIND_MISMATCH", "connector kind does not match"),
                )
                .await;
        }

        let source_secret = match self.resolve_credential(&source_profile).await {
            Ok(secret) => secret,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let target_secret = match self.resolve_credential(&target_profile).await {
            Ok(secret) => secret,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        let mut source = match self.connector.open(&source_profile, &source_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let mut target = match self.connector.open(&target_profile, &target_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        for (step_index, step) in flow.query_steps.iter().enumerate() {
            let binds = extract_named_binds(&step.upsert_sql).map_err(|_| {
                StartRunError::new(
                    "MAPPING_INVALID",
                    "target bind syntax could not be validated",
                )
            })?;
            let rows = match source.query(&step.select_sql).await {
                Ok(rows) => rows,
                Err(error) => {
                    return self
                        .persist_preflight_failure(&flow, &run_id, step_index, run_error(error))
                        .await
                }
            };
            if rows.rows.iter().any(|row| map_row(row, &binds).is_err()) {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        step_index,
                        RunError::connector(
                            "MAPPING_INVALID",
                            "source columns do not satisfy target bind parameters",
                        ),
                    )
                    .await;
            }
        }

        if let Err(error) = target.begin().await {
            return self
                .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                .await;
        }

        let mut state = RunState::running(flow.transaction_policy, flow.query_steps.len());
        for (step_index, step) in flow.query_steps.iter().enumerate() {
            let failure = match source.query(&step.select_sql).await {
                Ok(rows) => {
                    let binds = match extract_named_binds(&step.upsert_sql) {
                        Ok(binds) => binds,
                        Err(_) => {
                            return self
                                .rollback_after_failure(
                                    &run_id,
                                    &mut target,
                                    state,
                                    step_index,
                                    RunError::connector(
                                        "MAPPING_INVALID",
                                        "target bind syntax could not be validated",
                                    ),
                                )
                                .await
                        }
                    };
                    match rows
                        .rows
                        .iter()
                        .map(|row| map_row(row, &binds))
                        .collect::<Result<Vec<_>, _>>()
                    {
                        Ok(batch) => match target.execute_named(&step.upsert_sql, &batch).await {
                            Ok(affected_rows) => {
                                state
                                    .record_step_success(step_index, affected_rows)
                                    .map_err(|_| {
                                        StartRunError::new(
                                            "RUN_STATE_INVALID",
                                            "run state could not record a successful step",
                                        )
                                    })?;
                                None
                            }
                            Err(error) => Some(run_error(error)),
                        },
                        Err(_) => Some(RunError::connector(
                            "MAPPING_INVALID",
                            "source columns do not satisfy target bind parameters",
                        )),
                    }
                }
                Err(error) => Some(run_error(error)),
            };

            if let Some(error) = failure {
                return self
                    .rollback_after_failure(&run_id, &mut target, state, step_index, error)
                    .await;
            }
        }

        if let Err(error) = target.commit().await {
            let _ = target.rollback().await;
            let mut events = state.events().to_vec();
            events.push(RunEvent::TransactionFailed {
                error: run_error(error),
            });
            let rolled_back = RunState::from_history(
                flow.transaction_policy,
                RunStatus::RolledBack,
                state
                    .steps()
                    .iter()
                    .map(|step| step.status.clone())
                    .collect(),
                events,
            );
            return self.persist(&run_id, &rolled_back).await;
        }

        self.persist(&run_id, &state).await
    }

    async fn rollback_after_failure(
        &self,
        run_id: &str,
        target: &mut Box<dyn DatabaseSession>,
        mut state: RunState,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        state.record_step_failure(step_index, error).map_err(|_| {
            StartRunError::new(
                "RUN_STATE_INVALID",
                "run state could not record a failed step",
            )
        })?;
        let _ = target.rollback().await;
        self.persist(run_id, &state).await
    }

    async fn persist_preflight_failure(
        &self,
        flow: &Flow,
        run_id: &str,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        let mut steps = vec![StepStatus::NotRun; flow.query_steps.len()];
        let events = if let Some(step) = steps.get_mut(step_index) {
            *step = StepStatus::Failed;
            vec![RunEvent::StepFailed {
                step: step_index,
                error,
            }]
        } else {
            Vec::new()
        };
        let state =
            RunState::from_history(flow.transaction_policy, RunStatus::Failed, steps, events);
        self.persist(run_id, &state).await
    }

    async fn persist(&self, run_id: &str, state: &RunState) -> Result<RunSnapshot, StartRunError> {
        self.history
            .append_run(run_id, state)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn resolve_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ResolvedSecret, PortError> {
        match self.credentials.resolve(&profile.id).await {
            Ok(secret) => Ok(secret),
            Err(error)
                if error.code() == "CREDENTIAL_NOT_FOUND"
                    && profile.credential_ref != profile.id =>
            {
                let secret = self.credentials.resolve(&profile.credential_ref).await?;
                self.credentials.store(&profile.id, secret.clone()).await?;
                Ok(secret)
            }
            Err(error) => Err(error),
        }
    }

    fn run_id(&self, flow: &Flow) -> String {
        let timestamp = self
            .clock
            .now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}-{timestamp}", flow.id)
    }
}

fn run_error(error: PortError) -> RunError {
    RunError::connector(error.code(), error.message())
}
