use std::collections::HashSet;

use super::{DbKind, MappingError, NamedRow, Row, RowSet, ValidationError, Value};

pub fn validate_source_statement(sql: &str) -> Result<(), ValidationError> {
    validate_statement(sql, true)
}

pub fn validate_target_statement(kind: DbKind, sql: &str) -> Result<(), ValidationError> {
    match kind {
        DbKind::Oracle => validate_statement(sql, false),
    }
}

pub fn validate_row_set_columns(row_set: &RowSet, binds: &[String]) -> Result<(), MappingError> {
    let metadata_row = Row::from_columns(
        row_set
            .columns
            .iter()
            .cloned()
            .map(|column| (column, Value::Null))
            .collect(),
    );
    map_row(&metadata_row, binds).map(|_| ())
}

pub fn extract_named_binds(sql: &str) -> Result<Vec<String>, MappingError> {
    let mut binds = Vec::new();
    let mut seen = HashSet::new();

    for bind in extract_named_bind_occurrences(sql)? {
        if seen.insert(bind.to_ascii_uppercase()) {
            binds.push(bind);
        }
    }

    Ok(binds)
}

/// Returns every named bind in source order, retaining repeated placeholders.
///
/// [`extract_named_binds`] remains the deduplicated mapping contract. Drivers
/// that bind positionally use this occurrence-preserving variant instead.
pub fn extract_named_bind_occurrences(sql: &str) -> Result<Vec<String>, MappingError> {
    let bytes = sql.as_bytes();
    let mut binds = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => index = skip_quoted(bytes, index),
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = skip_line_comment(bytes, index + 2)
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2)
            }
            b':' => {
                let start = index + 1;
                if bytes.get(start).is_some_and(|byte| is_bind_start(*byte)) {
                    let mut end = start + 1;
                    while bytes.get(end).is_some_and(|byte| is_bind_continue(*byte)) {
                        end += 1;
                    }

                    let bind = &sql[start..end];
                    binds.push(bind.into());
                    index = end;
                } else if bytes.get(start).is_some_and(u8::is_ascii_digit) {
                    let mut end = start + 1;
                    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                        end += 1;
                    }
                    return Err(MappingError::NumericBind {
                        parameter: sql[start..end].into(),
                    });
                } else {
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }

    Ok(binds)
}

fn validate_statement(sql: &str, source: bool) -> Result<(), ValidationError> {
    let lexical = lexical_sql(sql)?;
    let tokens = lexical
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_uppercase())
        .collect::<Vec<_>>();

    let has_expected_first_keyword = if source {
        matches!(tokens.first().map(String::as_str), Some("SELECT" | "WITH"))
    } else {
        matches!(tokens.first().map(String::as_str), Some("INSERT" | "UPDATE" | "MERGE"))
    };
    if !has_expected_first_keyword {
        return Err(ValidationError::new(if source {
            "source SQL must begin with SELECT or WITH"
        } else {
            "Oracle target SQL must begin with INSERT, UPDATE, or MERGE"
        }));
    }

    if tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "CREATE"
                | "ALTER"
                | "DROP"
                | "TRUNCATE"
                | "RENAME"
                | "GRANT"
                | "REVOKE"
                | "COMMIT"
                | "ROLLBACK"
                | "SAVEPOINT"
                | "BEGIN"
                | "DECLARE"
                | "EXECUTE"
        )
    }) || tokens.windows(2).any(|pair| pair == ["SET", "TRANSACTION"])
    {
        return Err(ValidationError::new(
            "SQL contains a prohibited administrative, transaction, or PL/SQL statement",
        ));
    }

    if source
        && tokens.iter().any(|token| {
            matches!(
                token.as_str(),
                "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "LOCK"
            )
        })
    {
        return Err(ValidationError::new("source SQL must be read-only"));
    }

    if contains_numeric_bind(&lexical) {
        return Err(ValidationError::new(
            "numeric bind placeholders are not supported",
        ));
    }

    Ok(())
}

fn lexical_sql(sql: &str) -> Result<String, ValidationError> {
    let bytes = sql.as_bytes();
    let mut lexical = vec![b' '; bytes.len()];
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => {
                let next = skip_quoted(bytes, index);
                if next == bytes.len() && bytes.last() != Some(&bytes[index]) {
                    return Err(ValidationError::new(
                        "SQL contains an unterminated quoted literal",
                    ));
                }
                index = next;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = skip_line_comment(bytes, index + 2)
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let next = skip_block_comment(bytes, index + 2);
                if next == bytes.len() && !bytes.ends_with(b"*/") {
                    return Err(ValidationError::new(
                        "SQL contains an unterminated block comment",
                    ));
                }
                index = next;
            }
            byte => {
                lexical[index] = byte;
                index += 1;
            }
        }
    }

    let lexical = String::from_utf8(lexical).expect("SQL bytes remain valid UTF-8 after masking");
    if let Some(semicolon) = lexical.find(';') {
        if lexical[semicolon + 1..]
            .chars()
            .any(|character| !character.is_whitespace())
        {
            return Err(ValidationError::new(
                "multiple SQL statements are not supported",
            ));
        }
    }
    Ok(lexical)
}

fn contains_numeric_bind(sql: &str) -> bool {
    sql.as_bytes()
        .windows(2)
        .any(|window| window[0] == b':' && window[1].is_ascii_digit())
}

pub fn map_row(row: &Row, binds: &[String]) -> Result<NamedRow, MappingError> {
    let normalized = row.normalized_index()?;

    binds
        .iter()
        .map(|bind| {
            normalized
                .get(&bind.to_ascii_uppercase())
                .cloned()
                .map(|value| (bind.clone(), value))
                .ok_or_else(|| MappingError::MissingSourceColumn {
                    parameter: bind.clone(),
                })
        })
        .collect()
}

fn is_bind_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_bind_continue(byte: u8) -> bool {
    is_bind_start(byte) || byte.is_ascii_digit() || matches!(byte, b'$' | b'#')
}

fn skip_quoted(bytes: &[u8], mut index: usize) -> usize {
    let quote = bytes[index];
    index += 1;

    while index < bytes.len() {
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }

    index
}

fn skip_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index] != b'\n' {
        index += 1;
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() {
        if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
            return index + 2;
        }
        index += 1;
    }
    index
}
