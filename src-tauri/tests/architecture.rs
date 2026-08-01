#[test]
fn ui_commands_do_not_expose_generic_sql_execution() {
    let commands = std::fs::read_to_string("src/commands/mod.rs").unwrap();

    assert!(!commands.contains("execute_arbitrary_sql"));
}

#[test]
fn domain_remains_independent_from_infrastructure() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/domain");

    for entry in walkdir::WalkDir::new(root) {
        let path = entry.unwrap().path().to_owned();
        if path.extension().is_some_and(|ext| ext == "rs") {
            let source = std::fs::read_to_string(path).unwrap();
            assert!(!source.contains("crate::infrastructure"));
        }
    }
}
