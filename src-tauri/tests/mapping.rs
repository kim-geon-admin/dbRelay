use db_relay::domain::{
    extract_named_binds, map_row, validate_source_statement, validate_target_statement, DbKind,
    MappingError, Row, Value,
};

#[test]
fn accepts_read_only_source_queries_and_oracle_merge_targets() {
    assert!(validate_source_statement("SELECT id FROM customer").is_ok());
    assert!(validate_source_statement(
        "/* report */ WITH c AS (SELECT id FROM customer) SELECT id FROM c"
    )
    .is_ok());
    assert!(validate_target_statement(
        DbKind::Oracle,
        "MERGE INTO customer target USING dual ON (1 = 1) WHEN MATCHED THEN UPDATE SET target.id = 1",
    )
    .is_ok());
}

#[test]
fn rejects_unsafe_statement_forms_before_they_reach_a_connector() {
    assert!(validate_source_statement("DELETE FROM customer").is_err());
    assert!(validate_source_statement("SELECT id FROM customer; DELETE FROM customer").is_err());
    assert!(validate_target_statement(DbKind::Oracle, "TRUNCATE TABLE customer").is_err());
    assert!(validate_target_statement(DbKind::Oracle, "BEGIN DELETE FROM customer; END;").is_err());
    assert!(validate_target_statement(
        DbKind::Oracle,
        "MERGE INTO customer USING dual ON (id = :1)"
    )
    .is_err());
}

#[test]
fn maps_oracle_binds_to_source_columns_without_case_sensitivity() {
    let row = Row::from([
        ("customer_id", Value::Int(7)),
        ("EMAIL", Value::Text("a@b.com".into())),
    ]);
    let binds = extract_named_binds(
        "merge into customer using dual on (id = :CUSTOMER_ID) when matched then update set email = :email",
    )
    .unwrap();

    let mapped = map_row(&row, &binds).unwrap();

    assert_eq!(mapped.get("CUSTOMER_ID"), Some(&Value::Int(7)));
    assert_eq!(mapped.get("email"), Some(&Value::Text("a@b.com".into())));
}

#[test]
fn rejects_a_missing_target_parameter_before_execution() {
    let row = Row::from([("CUSTOMER_ID", Value::Int(7))]);
    let error = map_row(&row, &["CUSTOMER_ID".into(), "EMAIL".into()]).unwrap_err();

    assert_eq!(
        error,
        MappingError::MissingSourceColumn {
            parameter: "EMAIL".into()
        }
    );
}

#[test]
fn ignores_bind_like_text_in_literals_and_comments() {
    let binds = extract_named_binds(
        "update t set note = ':NOT_A_BIND', value = :VALUE -- :COMMENT\n/* :BLOCK_COMMENT */ where id = :ID",
    )
    .unwrap();

    assert_eq!(binds, ["VALUE", "ID"]);
}

#[test]
fn keeps_only_the_first_occurrence_of_each_bind() {
    let binds = extract_named_binds("update t set a = :ID, b = :name where id = :id and c = :NAME")
        .unwrap();

    assert_eq!(binds, ["ID", "name"]);
}

#[test]
fn rejects_duplicate_case_insensitive_source_columns() {
    let row = Row::from([("id", Value::Int(1)), ("ID", Value::Int(2))]);
    let error = map_row(&row, &["ID".into()]).unwrap_err();

    assert_eq!(
        error,
        MappingError::DuplicateSourceColumn {
            column: "ID".into()
        }
    );
}
