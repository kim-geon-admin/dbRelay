use db_relay::{
    connectors::{ConnectorRegistry, OracleConnector},
    domain::{ConnectionProfile, DbKind, NamedRow, OracleDate, OracleTimestamp, Row, Value},
};
use std::collections::BTreeMap;

#[test]
fn registry_resolves_oracle_without_exposing_driver_types_to_the_runner() {
    let registry = ConnectorRegistry::with_oracle(OracleConnector::for_test());

    assert_eq!(
        registry.for_kind(DbKind::Oracle).unwrap().kind(),
        DbKind::Oracle
    );
}

#[tokio::test]
async fn adapter_executes_named_batches_and_delegates_transactions() {
    let connector = OracleConnector::for_test();
    let mut session = connector
        .open_for_test(&profile(), "test-secret")
        .await
        .unwrap();
    let batch = vec![
        named_row([
            ("id", Value::Int(7)),
            ("label", Value::Text("first".into())),
        ]),
        named_row([
            ("id", Value::Int(8)),
            ("label", Value::Text("second".into())),
        ]),
    ];

    session.begin().await.unwrap();
    assert_eq!(
        session
            .execute_named(
                "merge into relay_test using dual on (id = :ID) when matched then update set label = :LABEL",
                &batch,
            )
            .await
            .unwrap(),
        2
    );
    session.commit().await.unwrap();
    session.rollback().await.unwrap();
}

#[tokio::test]
async fn adapter_expands_repeated_named_placeholders_in_sql_occurrence_order() {
    let connector = OracleConnector::for_test();
    let mut session = connector
        .open_for_test(&profile(), "test-secret")
        .await
        .unwrap();

    session
        .execute_named(
            "update relay_test set a = :VALUE, b = :VALUE",
            &[named_row([("VALUE", Value::Int(7))])],
        )
        .await
        .unwrap();

    assert_eq!(connector.test_bind_widths(), vec![2]);
}

#[tokio::test]
async fn adapter_rejects_ambiguous_timestamp_strings_before_oracle_execution() {
    let connector = OracleConnector::for_test();
    let mut session = connector
        .open_for_test(&profile(), "test-secret")
        .await
        .unwrap();

    let error = session
        .execute_named(
            "update relay_test set happened_at = :HAPPENED_AT",
            &[named_row([(
                "HAPPENED_AT",
                Value::Timestamp("2026-08-01 12:30:00".into()),
            )])],
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "BIND_TYPE_UNSUPPORTED");
}

#[tokio::test]
async fn adapter_accepts_structured_oracle_date_and_timestamp_binds() {
    let connector = OracleConnector::for_test();
    let mut session = connector
        .open_for_test(&profile(), "test-secret")
        .await
        .unwrap();

    let result = session
        .execute_named(
            "merge into relay_test using dual on (id = :ID) when matched then update set happened_on = :DATE_VALUE, happened_at = :TIMESTAMP_VALUE",
            &[named_row([
                ("ID", Value::Int(7)),
                (
                    "DATE_VALUE",
                    Value::OracleDate(OracleDate {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                    }),
                ),
                (
                    "TIMESTAMP_VALUE",
                    Value::OracleTimestamp(OracleTimestamp {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                        microsecond: 123_456,
                        tz_hour_offset: 0,
                        tz_minute_offset: 0,
                    }),
                ),
            ])],
        )
        .await;

    assert_eq!(result.unwrap(), 1);
    assert_eq!(connector.test_bind_widths(), vec![3]);
}

#[tokio::test]
async fn adapter_preserves_oracle_error_codes_and_masks_messages() {
    let connector = OracleConnector::for_test_with_failure(
        "ORA-00001",
        "unique constraint violated for test-secret",
        false,
    );
    let mut session = connector
        .open_for_test(&profile(), "test-secret")
        .await
        .unwrap();

    let error = session
        .execute_named(
            "merge into relay_test using dual on (id = :ID)",
            &[named_row([("ID", Value::Int(7))])],
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "ORA-00001");
    assert!(!error.retryable());
    assert!(!error.message().contains("test-secret"));
}

#[tokio::test]
#[ignore = "requires DB_RELAY_ORACLE_TEST_URL"]
async fn oracle_integration_named_merge_and_rollback() {
    let Some((profile, password)) = oracle_test_connection() else {
        return;
    };
    let table = format!("DB_RELAY_IT_{}", std::process::id());
    let connector = OracleConnector::default();
    let mut session = connector.open_for_test(&profile, &password).await.unwrap();
    let empty = NamedRow::default();

    session
        .execute_named(
            &format!(
                "BEGIN EXECUTE IMMEDIATE 'DROP TABLE {table} PURGE'; \
                 EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;"
            ),
            std::slice::from_ref(&empty),
        )
        .await
        .unwrap();
    session
        .execute_named(
            &format!(
                "CREATE TABLE {table} (id NUMBER PRIMARY KEY, label VARCHAR2(30), happened_on DATE, happened_at TIMESTAMP)"
            ),
            std::slice::from_ref(&empty),
        )
        .await
        .unwrap();

    let merge = format!(
        "MERGE INTO {table} target USING (SELECT :ID id, :LABEL label, :HAPPENED_ON happened_on, :HAPPENED_AT happened_at FROM dual) source \
         ON (target.id = source.id) WHEN MATCHED THEN UPDATE SET target.label = source.label, target.happened_on = source.happened_on, target.happened_at = source.happened_at \
         WHEN NOT MATCHED THEN INSERT (id, label, happened_on, happened_at) VALUES (source.id, source.label, source.happened_on, source.happened_at)"
    );
    session.begin().await.unwrap();
    session
        .execute_named(
            &merge,
            &[named_row([
                ("ID", Value::Int(1)),
                ("LABEL", Value::Text("merged".into())),
                (
                    "HAPPENED_ON",
                    Value::OracleDate(OracleDate {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                    }),
                ),
                (
                    "HAPPENED_AT",
                    Value::OracleTimestamp(OracleTimestamp {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                        microsecond: 123_456,
                        tz_hour_offset: 0,
                        tz_minute_offset: 0,
                    }),
                ),
            ])],
        )
        .await
        .unwrap();
    session.commit().await.unwrap();

    let merged = session
        .query(&format!(
            "SELECT label, happened_on, happened_at FROM {table} WHERE id = 1"
        ))
        .await
        .unwrap();
    assert_eq!(
        merged.rows[0].normalized_index().unwrap().get("LABEL"),
        Some(&Value::Text("merged".into()))
    );
    assert_eq!(
        merged.rows[0]
            .normalized_index()
            .unwrap()
            .get("HAPPENED_ON"),
        Some(&Value::OracleDate(OracleDate {
            year: 2026,
            month: 8,
            day: 1,
            hour: 12,
            minute: 30,
            second: 0,
        }))
    );
    assert_eq!(
        merged.rows[0]
            .normalized_index()
            .unwrap()
            .get("HAPPENED_AT"),
        Some(&Value::OracleTimestamp(OracleTimestamp {
            year: 2026,
            month: 8,
            day: 1,
            hour: 12,
            minute: 30,
            second: 0,
            microsecond: 123_456,
            tz_hour_offset: 0,
            tz_minute_offset: 0,
        }))
    );

    session.begin().await.unwrap();
    session
        .execute_named(
            &merge,
            &[named_row([
                ("ID", Value::Int(2)),
                ("LABEL", Value::Text("rolled back".into())),
                (
                    "HAPPENED_ON",
                    Value::OracleDate(OracleDate {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                    }),
                ),
                (
                    "HAPPENED_AT",
                    Value::OracleTimestamp(OracleTimestamp {
                        year: 2026,
                        month: 8,
                        day: 1,
                        hour: 12,
                        minute: 30,
                        second: 0,
                        microsecond: 123_456,
                        tz_hour_offset: 0,
                        tz_minute_offset: 0,
                    }),
                ),
            ])],
        )
        .await
        .unwrap();
    session.rollback().await.unwrap();
    let rolled_back = session
        .query(&format!("SELECT label FROM {table} WHERE id = 2"))
        .await
        .unwrap();
    assert!(rolled_back.rows.is_empty());

    session
        .execute_named(
            &format!("DROP TABLE {table} PURGE"),
            std::slice::from_ref(&empty),
        )
        .await
        .unwrap();
}

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: "oracle-test".into(),
        display_name: "Oracle test".into(),
        kind: DbKind::Oracle,
        host: "localhost".into(),
        port: 1521,
        service_name: "FREEPDB1".into(),
        username: "relay".into(),
        credential_ref: "credential://oracle-test".into(),
        enabled: true,
    }
}

fn named_row<const N: usize>(values: [(&str, Value); N]) -> NamedRow {
    values
        .into_iter()
        .map(|(name, value)| (name.into(), value))
        .collect::<BTreeMap<_, _>>()
}

fn oracle_test_connection() -> Option<(ConnectionProfile, String)> {
    let url = std::env::var("DB_RELAY_ORACLE_TEST_URL").ok()?;
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    let credentials_and_address = url.strip_prefix("oracle://")?;
    let (credentials, address) = credentials_and_address.split_once('@')?;
    let (username, password) = credentials.split_once(':')?;
    let (host_port, service_name) = address.split_once('/')?;
    let (host, port) = match host_port.split_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (host_port, 1521),
    };

    Some((
        ConnectionProfile {
            id: "oracle-integration".into(),
            display_name: "Oracle integration".into(),
            kind: DbKind::Oracle,
            host: host.into(),
            port,
            service_name: service_name.into(),
            username: username.into(),
            credential_ref: "credential://oracle-integration".into(),
            enabled: true,
        },
        password.into(),
    ))
}

#[test]
fn query_rows_can_preserve_driver_supplied_column_names() {
    let row = Row::from_columns(vec![("ROW_ID".into(), Value::Int(7))]);

    assert_eq!(
        row.normalized_index().unwrap().get("ROW_ID"),
        Some(&Value::Int(7))
    );
}
