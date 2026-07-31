use db_relay::domain::{
    RecoveryAction, RunError, RunState, RunStatus, StepStatus, TransactionPolicy,
};

#[test]
fn committed_run_pauses_for_user_recovery_after_a_step_failure() {
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 3);
    state.record_step_success(0, 12).unwrap();
    state
        .record_step_failure(
            1,
            RunError::connector("ORA-00001", "unique constraint violated"),
        )
        .unwrap();

    assert_eq!(
        state.status(),
        RunStatus::AwaitingRecovery { failed_step: 1 }
    );
    assert_eq!(
        state.steps()[0].status,
        StepStatus::Succeeded { affected_rows: 12 }
    );
    assert_eq!(state.steps()[1].status, StepStatus::Failed);
}

#[test]
fn stop_after_a_committed_step_preserves_success_and_marks_remaining_not_run() {
    let mut state = RunState::awaiting_recovery_after_step(1, 3);
    state.apply_recovery(RecoveryAction::Stop).unwrap();

    assert_eq!(state.status(), RunStatus::StoppedByUser);
    assert_eq!(state.steps()[2].status, StepStatus::NotRun);
}

#[test]
fn skipping_a_failed_step_marks_it_skipped_and_runs_the_next_step() {
    let mut state = RunState::awaiting_recovery_after_step(1, 3);

    state
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();

    assert_eq!(state.steps()[1].status, StepStatus::SkippedByUser);
    assert_eq!(state.status(), RunStatus::Running { step: 2 });
}

#[test]
fn editing_and_retrying_returns_the_run_to_the_failed_step() {
    let mut state = RunState::awaiting_recovery_after_step(1, 3);

    state.apply_recovery(RecoveryAction::EditAndRetry).unwrap();

    assert_eq!(state.status(), RunStatus::Running { step: 1 });
    assert_eq!(state.steps()[1].status, StepStatus::Failed);
}

#[test]
fn recovery_is_rejected_when_the_run_is_not_awaiting_user_input() {
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 1);

    let error = state.apply_recovery(RecoveryAction::Stop).unwrap_err();

    assert_eq!(
        error,
        RunError::InvalidTransition {
            status: RunStatus::Running { step: 0 },
            action: RecoveryAction::Stop,
        }
    );
}

#[test]
fn connector_errors_mask_named_and_supplied_credential_values() {
    let error = RunError::connector_with_credential_values(
        "ORA-01017",
        "connection failed: user id=scott password=top-secret token=abc123 for SCOTT",
        ["SCOTT", "top-secret", "abc123"],
    );
    let RunError::Connector { message, .. } = error else {
        panic!("expected connector error");
    };

    assert!(message.contains("[REDACTED]"));
    assert!(!message.contains("scott"));
    assert!(!message.contains("SCOTT"));
    assert!(!message.contains("top-secret"));
    assert!(!message.contains("abc123"));
}
