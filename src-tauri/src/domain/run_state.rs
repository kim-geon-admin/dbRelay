use serde::{Deserialize, Serialize};

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
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RunError {
    Connector {
        code: String,
        message: String,
    },
    InvalidTransition {
        status: RunStatus,
        action: RecoveryAction,
    },
    InvalidStep {
        expected: usize,
        received: usize,
    },
}

impl RunError {
    pub fn connector(code: impl Into<String>, message: impl AsRef<str>) -> Self {
        Self::Connector {
            code: code.into(),
            message: super::mask_sensitive_text(message.as_ref()),
        }
    }

    pub fn connector_with_credential_values(
        code: impl Into<String>,
        message: impl AsRef<str>,
        credential_values: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::Connector {
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
            status: RunStatus::Running { step: 0 },
            steps: vec![
                RunStep {
                    status: StepStatus::NotRun,
                };
                step_count
            ],
            events: Vec::new(),
        }
    }

    pub fn awaiting_recovery_after_step(failed_step: usize, step_count: usize) -> Self {
        let mut state = Self::running(TransactionPolicy::CommitSuccesses, step_count);
        if let Some(step) = state.steps.get_mut(failed_step) {
            step.status = StepStatus::Failed;
        }
        state.status = RunStatus::AwaitingRecovery { failed_step };
        state
    }

    pub fn status(&self) -> RunStatus {
        self.status.clone()
    }

    pub fn steps(&self) -> &[RunStep] {
        &self.steps
    }

    pub fn events(&self) -> &[RunEvent] {
        &self.events
    }

    pub fn record_step_success(&mut self, step: usize, affected_rows: u64) -> Result<(), RunError> {
        self.require_running_step(step)?;
        self.steps[step].status = StepStatus::Succeeded { affected_rows };
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

        self.events.push(RunEvent::RecoveryApplied {
            step: failed_step,
            action,
        });

        match action {
            RecoveryAction::EditAndRetry => self.status = RunStatus::Running { step: failed_step },
            RecoveryAction::SkipAndContinue => {
                self.steps[failed_step].status = StepStatus::SkippedByUser;
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

        if step + 1 == self.steps.len() {
            self.status = RunStatus::Completed;
        } else {
            self.status = RunStatus::Running { step: step + 1 };
        }
        Ok(())
    }

    fn require_running_step(&self, step: usize) -> Result<(), RunError> {
        match self.status {
            RunStatus::Running { step: expected } if expected == step => Ok(()),
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
}
