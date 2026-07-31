mod support;

use db_relay::{
    application::ports::{CredentialStore, DatabaseConnectorFactory, DatabaseSession},
    domain::{ConnectionProfile, DbKind, NamedRow, RowSet, Value},
};
use std::path::Path;
use support::{FakeConnectorFactory, FakeSession, MemoryCredentialStore};

#[test]
fn production_library_does_not_export_test_fakes() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let application_module = std::fs::read_to_string(manifest_dir.join("src/application/mod.rs"))
        .expect("application module should exist");

    assert!(!application_module.contains("test_support"));
    assert!(!manifest_dir
        .join("src/application/test_support.rs")
        .exists());
}

#[test]
fn production_ports_do_not_offer_a_raw_secret_constructor() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ports = std::fs::read_to_string(manifest_dir.join("src/application/ports.rs"))
        .expect("ports module should exist");

    assert!(!ports.contains("pub fn new(value: impl Into<String>) -> Self"));
    assert!(ports.contains("#[cfg(feature = \"test-support\")]"));
}

#[tokio::test]
async fn factory_sessions_are_isolated_while_the_observer_keeps_each_open_log() {
    let factory = FakeConnectorFactory::with_session(
        "source",
        FakeSession::with_rows(RowSet::single([("ID", Value::Int(1))])),
    );
    let credential_store = MemoryCredentialStore::with_secret("credential://source", "secret");
    let secret = credential_store
        .resolve("credential://source")
        .await
        .unwrap();
    let profile = ConnectionProfile {
        id: "source".into(),
        display_name: "Source".into(),
        kind: DbKind::Oracle,
        host: "localhost".into(),
        port: 1521,
        service_name: "XE".into(),
        username: "scott".into(),
        credential_ref: "credential://source".into(),
        enabled: true,
    };

    let mut first = factory.open(&profile, &secret).await.unwrap();
    first.begin().await.unwrap();
    first.commit().await.unwrap();

    let mut second = factory.open(&profile, &secret).await.unwrap();
    second.begin().await.unwrap();
    second.rollback().await.unwrap();

    assert_eq!(
        factory.operations_for_open("source", 0),
        ["begin", "commit"]
    );
    assert_eq!(
        factory.operations_for_open("source", 1),
        ["begin", "rollback"]
    );
}

#[tokio::test]
async fn fake_session_returns_configured_rows_and_records_named_batch() {
    let mut session = FakeSession::with_rows(RowSet::single([("ID", Value::Int(1))]));

    assert_eq!(
        session
            .query("select id from customer")
            .await
            .unwrap()
            .rows
            .len(),
        1
    );

    session
        .execute_named(
            "merge into customer ... :ID",
            &[NamedRow::from([("ID".into(), Value::Int(1))])],
        )
        .await
        .unwrap();

    assert_eq!(session.executed_sql(), ["merge into customer ... :ID"]);
}

#[tokio::test]
async fn fake_session_records_transaction_order_and_fails_configured_statement() {
    let mut session = FakeSession::with_rows(RowSet::default());
    session.fail_on_execute_named("merge into customer ... :ID");

    session.begin().await.unwrap();
    assert!(session
        .execute_named("merge into customer ... :ID", &[])
        .await
        .is_err());
    session.rollback().await.unwrap();

    assert_eq!(
        session.operations(),
        ["begin", "execute:merge into customer ... :ID", "rollback"]
    );
}
