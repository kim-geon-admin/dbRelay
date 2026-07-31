use db_relay::{
    application::{ports::DatabaseSession, test_support::FakeSession},
    domain::{NamedRow, RowSet, Value},
};

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
