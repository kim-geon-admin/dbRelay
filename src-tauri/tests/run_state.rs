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
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();
    state.apply_recovery(RecoveryAction::Stop).unwrap();

    assert_eq!(state.status(), RunStatus::StoppedByUser);
    assert_eq!(state.steps()[2].status, StepStatus::NotRun);
}

#[test]
fn skipping_a_failed_step_marks_it_skipped_and_runs_the_next_step() {
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();

    state
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();

    assert_eq!(state.steps()[1].status, StepStatus::SkippedByUser);
    assert_eq!(state.status(), RunStatus::Running { step: 2 });
}

#[test]
fn editing_and_retrying_returns_the_run_to_the_failed_step() {
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();

    state.apply_recovery(RecoveryAction::EditAndRetry).unwrap();

    assert_eq!(state.status(), RunStatus::Running { step: 1 });
    assert_eq!(state.steps()[1].status, StepStatus::Failed);
}

#[test]
fn reserved_recovery_can_be_returned_to_awaiting_user_input() {
    // Would fail if reserving a recovery action permanently moved the run into
    // Running or a terminal state before external recovery work begins.
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();

    state
        .reserve_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();
    assert!(matches!(
        state.status(),
        RunStatus::RecoveryPending {
            failed_step: 1,
            action: RecoveryAction::SkipAndContinue,
        }
    ));

    state.return_reserved_recovery_to_awaiting().unwrap();

    assert_eq!(
        state.status(),
        RunStatus::AwaitingRecovery { failed_step: 1 }
    );
}

#[test]
fn rollback_uncertainty_blocks_ordinary_recovery() {
    // Would fail if a rollback error was reported as a successful rollback or
    // an ordinary recoverable step failure.
    let mut state = RunState::running(TransactionPolicy::AllOrNothing, 1);
    state
        .record_step_failure(0, RunError::connector("ORA-00001", "write failed"))
        .unwrap();
    state
        .mark_in_doubt(
            0,
            RunError::connector("ORA-03113", "rollback connection lost"),
        )
        .unwrap();

    assert!(matches!(
        state.status(),
        RunStatus::InDoubt { step: 0, reason: _ }
    ));
    assert!(state
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .is_err());
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
    let message = error.connector_message().expect("expected connector error");

    assert!(message.contains("[REDACTED]"));
    assert!(!message.contains("scott"));
    assert!(!message.contains("SCOTT"));
    assert!(!message.contains("top-secret"));
    assert!(!message.contains("abc123"));
}

#[test]
fn supplied_credentials_are_masked_longest_first() {
    let error = RunError::connector_with_credential_values(
        "ORA-01017",
        "connection failed for admin123",
        ["admin", "admin123"],
    );
    let message = error.connector_message().expect("expected connector error");

    assert!(!message.contains("admin123"));
    assert!(!message.contains("123"));
}

#[test]
fn deserialized_connector_errors_are_masked_before_they_are_persisted() {
    let error: RunError = serde_json::from_str(
        r#"{"type":"connector","detail":{"code":"ORA-01017","message":"password=raw-secret"}}"#,
    )
    .unwrap();
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 1);

    state.record_step_failure(0, error).unwrap();

    let persisted = serde_json::to_string(state.events()).unwrap();
    assert!(!persisted.contains("raw-secret"));
    assert!(persisted.contains("[REDACTED]"));
}

#[test]
fn empty_runs_are_completed_without_a_running_step() {
    let state = RunState::running(TransactionPolicy::CommitSuccesses, 0);

    assert_eq!(state.status(), RunStatus::Completed);
    assert!(state.steps().is_empty());
}

#[test]
fn awaiting_recovery_rejects_an_out_of_range_failed_step() {
    let error = RunState::awaiting_recovery_after_step(3, 3).unwrap_err();

    assert_eq!(
        error,
        RunError::StepOutOfBounds {
            step: 3,
            step_count: 3,
        }
    );
}

#[test]
fn malformed_deserialized_state_rejects_step_failure_without_panicking() {
    let mut state: RunState = serde_json::from_str(
        r#"{"policy":"commit_successes","status":{"running":{"step":0}},"steps":[],"events":[]}"#,
    )
    .unwrap();

    let error = state
        .record_step_failure(0, RunError::connector("ORA-00001", "constraint violated"))
        .unwrap_err();

    assert_eq!(
        error,
        RunError::StepOutOfBounds {
            step: 0,
            step_count: 0,
        }
    );
}
