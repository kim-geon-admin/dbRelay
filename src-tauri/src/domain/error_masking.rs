const REDACTED: &str = "[REDACTED]";
const SENSITIVE_KEYS: [&str; 3] = ["password", "user id", "token"];

pub fn mask_sensitive_text(text: &str) -> String {
    mask_sensitive_text_with_values(text, &[])
}

pub(crate) fn mask_sensitive_text_with_values(text: &str, values: &[String]) -> String {
    let mut masked = mask_named_values(text);

    for value in values.iter().filter(|value| !value.is_empty()) {
        masked = replace_case_insensitive(&masked, value, REDACTED);
    }

    masked
}

fn mask_named_values(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;

    while cursor < text.len() {
        let Some((key_start, key)) = next_sensitive_key(&lower, cursor) else {
            result.push_str(&text[cursor..]);
            break;
        };

        result.push_str(&text[cursor..key_start]);
        let key_end = key_start + key.len();
        let mut separator_end = key_end;
        while text
            .as_bytes()
            .get(separator_end)
            .is_some_and(u8::is_ascii_whitespace)
        {
            separator_end += 1;
        }

        if !matches!(text.as_bytes().get(separator_end), Some(b'=') | Some(b':')) {
            result.push_str(&text[key_start..key_end]);
            cursor = key_end;
            continue;
        }

        separator_end += 1;
        while text
            .as_bytes()
            .get(separator_end)
            .is_some_and(u8::is_ascii_whitespace)
        {
            separator_end += 1;
        }

        let value_end = end_of_sensitive_value(text, separator_end);
        result.push_str(&text[key_start..separator_end]);
        result.push_str(REDACTED);
        cursor = value_end;
    }

    result
}

fn next_sensitive_key<'a>(lower: &str, cursor: usize) -> Option<(usize, &'a str)> {
    SENSITIVE_KEYS
        .iter()
        .filter_map(|key| {
            lower[cursor..]
                .find(key)
                .map(|relative_start| (cursor + relative_start, *key))
        })
        .filter(|(start, _)| {
            *start == 0
                || !lower.as_bytes()[start - 1].is_ascii_alphanumeric()
                    && lower.as_bytes()[start - 1] != b'_'
        })
        .min_by_key(|(start, _)| *start)
}

fn end_of_sensitive_value(text: &str, start: usize) -> usize {
    match text.as_bytes().get(start) {
        Some(b'\'') | Some(b'\"') => {
            let quote = text.as_bytes()[start];
            text[start + 1..]
                .find(quote as char)
                .map_or(text.len(), |offset| start + offset + 2)
        }
        _ => text[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | ';' | '&' | ')')
            })
            .map_or(text.len(), |offset| start + offset),
    }
}

fn replace_case_insensitive(text: &str, value: &str, replacement: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let lower = text.to_ascii_lowercase();
    let value_lower = value.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find(&value_lower) {
        let start = cursor + relative_start;
        result.push_str(&text[cursor..start]);
        result.push_str(replacement);
        cursor = start + value.len();
    }

    result.push_str(&text[cursor..]);
    result
}
