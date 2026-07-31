use std::collections::HashSet;

use super::{MappingError, NamedRow, Row};

pub fn extract_named_binds(sql: &str) -> Result<Vec<String>, MappingError> {
    let bytes = sql.as_bytes();
    let mut binds = Vec::new();
    let mut seen = HashSet::new();
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
                    if seen.insert(bind.to_ascii_uppercase()) {
                        binds.push(bind.into());
                    }
                    index = end;
                } else {
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }

    Ok(binds)
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
