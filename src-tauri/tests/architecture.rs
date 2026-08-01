fn source_path(relative_path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(relative_path)
}

fn rust_sources(relative_directory: &str) -> Vec<std::path::PathBuf> {
    walkdir::WalkDir::new(source_path(relative_directory))
        .into_iter()
        .map(|entry| entry.unwrap().into_path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .collect()
}

fn code_without_comments_and_strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && bytes[index] != b'\n' {
                output.push(' ');
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            let mut depth = 1;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    output.push_str("  ");
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    output.push_str("  ");
                    index += 2;
                } else {
                    output.push(if bytes[index] == b'\n' { '\n' } else { ' ' });
                    index += 1;
                }
            }
        } else if bytes[index] == b'"' {
            output.push(' ');
            index += 1;
            while index < bytes.len() {
                let byte = bytes[index];
                output.push(if byte == b'\n' { '\n' } else { ' ' });
                index += 1;
                if byte == b'\\' && index < bytes.len() {
                    output.push(' ');
                    index += 1;
                } else if byte == b'"' {
                    break;
                }
            }
        } else {
            output.push(bytes[index] as char);
            index += 1;
        }
    }

    output
}

fn path_tokens(source: &str) -> Vec<String> {
    let code = code_without_comments_and_strings(source);
    let bytes = code.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index].is_ascii_alphabetic() || bytes[index] == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            tokens.push(code[start..index].to_owned());
        } else if bytes[index..].starts_with(b"::") {
            tokens.push("::".to_owned());
            index += 2;
        } else {
            index += 1;
        }
    }

    tokens
}

fn references_infrastructure(source: &str) -> bool {
    let tokens = path_tokens(source);

    for index in 0..tokens.len() {
        if tokens.get(index).is_some_and(|token| token == "crate")
            && tokens.get(index + 1).is_some_and(|token| token == "::")
            && tokens
                .get(index + 2)
                .is_some_and(|token| token == "infrastructure")
        {
            return true;
        }

        let mut current = index;
        while tokens.get(current).is_some_and(|token| token == "super")
            && tokens.get(current + 1).is_some_and(|token| token == "::")
        {
            match tokens.get(current + 2).map(String::as_str) {
                Some("infrastructure") => return true,
                Some("super") => current += 2,
                _ => break,
            }
        }
    }

    false
}

#[test]
fn ui_commands_do_not_expose_generic_sql_execution() {
    let command_sources = rust_sources("commands");

    for path in command_sources {
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(
            !source.contains("execute_arbitrary_sql"),
            "generic SQL execution exposed by {}",
            path.display()
        );
    }

    let handler_registration = std::fs::read_to_string(source_path("lib.rs")).unwrap();
    assert!(
        !handler_registration.contains("execute_arbitrary_sql"),
        "generic SQL execution registered in src/lib.rs"
    );
}

#[test]
fn domain_remains_independent_from_infrastructure() {
    for path in rust_sources("domain") {
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(
            !references_infrastructure(&source),
            "domain depends on infrastructure in {}",
            path.display()
        );
    }
}

#[test]
fn infrastructure_guard_detects_absolute_and_relative_paths() {
    assert!(references_infrastructure(
        "use crate::infrastructure::sqlite::SqliteStore;"
    ));
    assert!(references_infrastructure(
        "use super::infrastructure::sqlite::SqliteStore;"
    ));
    assert!(references_infrastructure(
        "use super::super::infrastructure::sqlite::SqliteStore;"
    ));
}

#[test]
fn infrastructure_guard_ignores_comments_and_string_literals() {
    assert!(!references_infrastructure(
        "// crate::infrastructure\nlet example = \"super::infrastructure\";"
    ));
}
