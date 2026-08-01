use db_relay::{
    commands::{
        ConnectionRequest, ConnectionResponse, FlowRequest, QueryStepRequest, RunHistoryResponse,
        UpdateConnectionRequest,
    },
    domain::{ConnectionProfile, CredentialStorage, DbKind, RunEvent, RunStatus, StepStatus, TransactionPolicy},
};

fn profile_with_secret_reference() -> ConnectionProfile {
    ConnectionProfile {
        id: "production".into(),
        display_name: "Production".into(),
        kind: DbKind::Oracle,
        host: "db.example.test".into(),
        port: 1521,
        service_name: "ORCLPDB1".into(),
        username: "relay".into(),
        credential_ref: "keyring://production-password".into(),
        credential_storage: CredentialStorage::Keyring,
        plaintext_password: None,
        enabled: true,
        source_read_only: true,
    }
}

#[test]
fn connection_request_debug_output_redacts_credential_material() {
    let create = ConnectionRequest {
        id: "production".into(),
        display_name: "Production".into(),
        kind: DbKind::Oracle,
        host: "db.example.test".into(),
        port: 1521,
        service_name: "ORCLPDB1".into(),
        username: "relay".into(),
        credential_storage: CredentialStorage::Keyring,
        source_read_only: true,
        secret: "create-secret".into(),
    };
    let update = UpdateConnectionRequest {
        id: "production".into(),
        display_name: "Production".into(),
        kind: DbKind::Oracle,
        host: "db.example.test".into(),
        port: 1521,
        service_name: "ORCLPDB1".into(),
        username: "relay".into(),
        credential_storage: CredentialStorage::Keyring,
        source_read_only: true,
        enabled: true,
        replacement_secret: Some("replacement-secret".into()),
    };

    let debug = format!("{create:?} {update:?}");

    assert!(!debug.contains("create-secret"));
    assert!(!debug.contains("replacement-secret"));
}

#[test]
fn connection_response_never_serializes_credential_material() {
    let response = ConnectionResponse::from(profile_with_secret_reference());

    let json = serde_json::to_string(&response).unwrap();

    assert!(!json.contains("password"));
    assert!(!json.contains("token"));
    assert!(!json.contains("credential_ref"));
    assert!(!json.contains("keyring://production-password"));
}

#[test]
fn plaintext_connection_response_serializes_its_password() {
    let response = ConnectionResponse::from(ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile_with_secret_reference()
    });

    let json = serde_json::to_string(&response).unwrap();

    assert!(json.contains("plaintext"));
    assert!(json.contains("visible-password"));
}

#[test]
fn run_history_response_never_serializes_execution_data() {
    let response = RunHistoryResponse {
        run_id: "migration-42".into(),
        flow_id: "customer-relay".into(),
        flow_version: 3,
        started_at: 1,
        ended_at: Some(2),
        policy: TransactionPolicy::CommitSuccesses,
        status: RunStatus::Completed,
        steps: vec![StepStatus::Succeeded { affected_rows: 3 }],
        events: vec![RunEvent::RecoveryApplied {
            step: 0,
            action: db_relay::domain::RecoveryAction::SkipAndContinue,
        }],
    };

    let json = serde_json::to_string(&response).unwrap();

    assert!(!json.contains("source_rows"));
    assert!(!json.contains("bind_values"));
    assert!(!json.contains("binding"));
}

#[test]
fn run_event_connector_error_uses_the_tagged_detail_wire_contract() {
    let event = RunEvent::StepFailed {
        step: 0,
        error: db_relay::domain::RunError::connector("ORA-00001", "Unique constraint conflict"),
    };

    let json = serde_json::to_value(event).unwrap();

    assert_eq!(json["type"], "step_failed");
    assert_eq!(json["error"]["type"], "connector");
    assert_eq!(json["error"]["detail"]["code"], "ORA-00001");
    assert_eq!(
        json["error"]["detail"]["message"],
        "Unique constraint conflict"
    );
}

#[test]
fn flow_request_rejects_unsafe_source_and_target_statements() {
    let mut request = valid_flow_request();
    request.query_steps[0].select_sql = "DELETE FROM customer".into();
    assert_eq!(request.into_flow().unwrap_err().code, "INVALID_REQUEST");

    let mut request = valid_flow_request();
    request.query_steps[0].upsert_sql = "TRUNCATE TABLE customer".into();
    assert_eq!(request.into_flow().unwrap_err().code, "INVALID_REQUEST");
}

#[test]
fn flow_request_rejects_the_same_connection_as_source_and_target() {
    let mut request = valid_flow_request();
    request.target_connection_id = request.source_connection_id.clone();

    let error = request.into_flow().unwrap_err();

    assert_eq!(error.code, "INVALID_REQUEST");
    assert!(error.detail.contains("must be different"));
}

fn valid_flow_request() -> FlowRequest {
    FlowRequest {
        id: "flow-1".into(),
        name: "Migration".into(),
        source_connection_id: "source".into(),
        target_connection_id: "target".into(),
        query_steps: vec![QueryStepRequest {
            id: "customer".into(),
            select_sql: "SELECT id FROM customer".into(),
            upsert_sql: "MERGE INTO customer USING dual ON (id = :ID)".into(),
        }],
        transaction_policy: TransactionPolicy::AllOrNothing,
        version: 1,
    }
}
