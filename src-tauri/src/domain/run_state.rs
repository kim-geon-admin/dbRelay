use serde::{Deserialize, Deserializer, Serialize};

use super::{error_masking::mask_sensitive_text_with_values, TransactionPolicy};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Draft,
    Validating,
    Running { step: usize },
    AwaitingRecovery { failed_step: usize },
    Completed,
    RolledBack,
    StoppedByUser,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    NotRun,
    Succeeded { affected_rows: u64 },
    Failed,
    SkippedByUser,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    EditAndRetry,
    SkipAndContinue,
    Stop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RunEvent {
    StepSucceeded { step: usize, affected_rows: u64 },
    StepFailed { step: usize, error: RunError },
    RecoveryApplied { step: usize, action: RecoveryAction },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "detail")]
pub enum RunError {
    Connector(ConnectorError),
    InvalidTransition {
        status: RunStatus,
        action: RecoveryAction,
    },
    InvalidStep {
        expected: usize,
        received: usize,
    },
    StepOutOfBounds {
        step: usize,
        step_count: usize,
    },
}

impl RunError {
    pub fn connector(code: impl Into<String>, message: impl AsRef<str>) -> Self {
        Self::Connector(ConnectorError::new(code, message))
    }

    pub fn connector_with_credential_values(
        code: impl Into<String>,
        message: impl AsRef<str>,
        credential_values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::Connector(ConnectorError::with_credential_values(
            code,
            message,
            credential_values,
        ))
    }

    pub fn connector_message(&self) -> Option<&str> {
        match self {
            Self::Connector(error) => Some(error.message()),
            _ => None,
        }
    }

    pub fn history_code(&self) -> String {
        match self {
            Self::Connector(error) => super::mask_sensitive_text(error.code()),
            Self::InvalidTransition { .. } => "INVALID_TRANSITION".into(),
            Self::InvalidStep { .. } => "INVALID_STEP".into(),
            Self::StepOutOfBounds { .. } => "STEP_OUT_OF_BOUNDS".into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ConnectorError {
    code: String,
    message: String,
}

impl ConnectorError {
    fn new(code: impl Into<String>, message: impl AsRef<str>) -> Self {
        Self {
            code: code.into(),
            message: super::mask_sensitive_text(message.as_ref()),
        }
    }

    fn with_credential_values(
        code: impl Into<String>,
        message: impl AsRef<str>,
        credential_values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            code: code.into(),
            message: mask_sensitive_text_with_values(
                message.as_ref(),
                &credential_values
                    .into_iter()
                    .map(Into::into)
                    .collect::<Vec<_>>(),
            ),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl<'de> Deserialize<'de> for ConnectorError {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireError {
            code: String,
            message: String,
        }

        let wire = WireError::deserialize(deserializer)?;
        Ok(Self::new(wire.code, wire.message))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunStep {
    pub status: StepStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunState {
    policy: TransactionPolicy,
    status: RunStatus,
    steps: Vec<RunStep>,
    events: Vec<RunEvent>,
}

impl RunState {
    pub fn running(policy: TransactionPolicy, step_count: usize) -> Self {
        Self {
            policy,
            status: if step_count == 0 {
                RunStatus::Completed
            } else {
                RunStatus::Running { step: 0 }
            },
            steps: vec![
                RunStep {
                    status: StepStatus::NotRun,
                };
                step_count
            ],
            events: Vec::new(),
        }
    }

    pub fn awaiting_recovery_after_step(
        failed_step: usize,
        step_count: usize,
    ) -> Result<Self, RunError> {
        let mut state = Self::running(TransactionPolicy::CommitSuccesses, step_count);
        state.validate_step(failed_step)?;
        let error = state.out_of_bounds(failed_step);
        let step = state.steps.get_mut(failed_step).ok_or(error)?;
        step.status = StepStatus::Failed;
        state.status = RunStatus::AwaitingRecovery { failed_step };
        Ok(state)
    }

    pub fn status(&self) -> RunStatus {
        self.status.clone()
    }

    pub fn policy(&self) -> TransactionPolicy {
        self.policy
    }

    pub fn steps(&self) -> &[RunStep] {
        &self.steps
    }

    pub fn events(&self) -> &[RunEvent] {
        &self.events
    }

    pub fn from_history(
        policy: TransactionPolicy,
        status: RunStatus,
        step_statuses: Vec<StepStatus>,
        events: Vec<RunEvent>,
    ) -> Self {
        Self {
            policy,
            status,
            steps: step_statuses
                .into_iter()
                .map(|status| RunStep { status })
                .collect(),
            events,
        }
    }

    pub fn record_step_success(&mut self, step: usize, affected_rows: u64) -> Result<(), RunError> {
        self.require_running_step(step)?;
        let error = self.out_of_bounds(step);
        let run_step = self.steps.get_mut(step).ok_or(error)?;
        run_step.status = StepStatus::Succeeded { affected_rows };
        self.events.push(RunEvent::StepSucceeded {
            step,
            affected_rows,
        });
        self.advance_after_success()
    }

    pub fn record_step_failure(&mut self, step: usize, error: RunError) -> Result<(), RunError> {
        self.require_running_step(step)?;
        self.steps[step].status = StepStatus::Failed;
        self.events.push(RunEvent::StepFailed { step, error });
        self.status = match self.policy {
            TransactionPolicy::CommitSuccesses => RunStatus::AwaitingRecovery { failed_step: step },
            TransactionPolicy::AllOrNothing => RunStatus::RolledBack,
        };
        Ok(())
    }

    pub fn apply_recovery(&mut self, action: RecoveryAction) -> Result<(), RunError> {
        let RunStatus::AwaitingRecovery { failed_step } = self.status else {
            return Err(RunError::InvalidTransition {
                status: self.status.clone(),
                action,
            });
        };
        self.validate_step(failed_step)?;

        self.events.push(RunEvent::RecoveryApplied {
            step: failed_step,
            action,
        });

        match action {
            RecoveryAction::EditAndRetry => self.status = RunStatus::Running { step: failed_step },
            RecoveryAction::SkipAndContinue => {
                let error = self.out_of_bounds(failed_step);
                let step = self.steps.get_mut(failed_step).ok_or(error)?;
                step.status = StepStatus::SkippedByUser;
                if failed_step + 1 == self.steps.len() {
                    self.status = RunStatus::Completed;
                } else {
                    self.status = RunStatus::Running {
                        step: failed_step + 1,
                    };
                }
            }
            RecoveryAction::Stop => self.status = RunStatus::StoppedByUser,
        }

        Ok(())
    }

    pub fn advance_after_success(&mut self) -> Result<(), RunError> {
        let RunStatus::Running { step } = self.status else {
            return Err(RunError::InvalidTransition {
                status: self.status.clone(),
                action: RecoveryAction::EditAndRetry,
            });
        };

        self.validate_step(step)?;

        if step == self.steps.len() - 1 {
            self.status = RunStatus::Completed;
        } else {
            self.status = RunStatus::Running { step: step + 1 };
        }
        Ok(())
    }

    fn require_running_step(&self, step: usize) -> Result<(), RunError> {
        match self.status {
            RunStatus::Running { step: expected } if expected == step => self.validate_step(step),
            RunStatus::Running { step: expected } => Err(RunError::InvalidStep {
                expected,
                received: step,
            }),
            _ => Err(RunError::InvalidTransition {
                status: self.status.clone(),
                action: RecoveryAction::EditAndRetry,
            }),
        }
    }

    fn validate_step(&self, step: usize) -> Result<(), RunError> {
        if step < self.steps.len() {
            Ok(())
        } else {
            Err(self.out_of_bounds(step))
        }
    }

    fn out_of_bounds(&self, step: usize) -> RunError {
        RunError::StepOutOfBounds {
            step,
            step_count: self.steps.len(),
        }
    }
}
