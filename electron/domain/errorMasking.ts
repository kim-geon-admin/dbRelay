const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = ["password", "user id", "token"] as const;

export function maskSensitiveText(text: string, secrets: readonly string[] = []): string {
  let masked = maskNamedValues(text);
  const longestFirst = secrets
    .filter((secret) => secret.length > 0)
    .slice()
    .sort((left, right) => right.length - left.length);

  for (const secret of longestFirst) {
    masked = replaceCaseInsensitive(masked, secret, REDACTED);
  }
  return masked;
}

function maskNamedValues(text: string): string {
  const lower = asciiLower(text);
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const sensitive = nextSensitiveKey(lower, cursor);
    if (sensitive === undefined) {
      result += text.slice(cursor);
      break;
    }

    const [keyStart, key] = sensitive;
    result += text.slice(cursor, keyStart);
    const keyEnd = keyStart + key.length;
    let separatorEnd = keyEnd;
    while (separatorEnd < text.length && isAsciiWhitespace(text[separatorEnd])) {
      separatorEnd += 1;
    }

    if (text[separatorEnd] !== "=" && text[separatorEnd] !== ":") {
      result += text.slice(keyStart, keyEnd);
      cursor = keyEnd;
      continue;
    }

    separatorEnd += 1;
    while (separatorEnd < text.length && isAsciiWhitespace(text[separatorEnd])) {
      separatorEnd += 1;
    }

    const valueEnd = endOfSensitiveValue(text, separatorEnd);
    result += text.slice(keyStart, separatorEnd);
    result += REDACTED;
    cursor = valueEnd;
  }

  return result;
}

function nextSensitiveKey(lower: string, cursor: number): [number, string] | undefined {
  let next: [number, string] | undefined;

  for (const key of SENSITIVE_KEYS) {
    let start = lower.indexOf(key, cursor);
    while (start >= 0 && !isSensitiveKeyBoundary(lower, start)) {
      start = lower.indexOf(key, start + 1);
    }
    if (start >= 0 && (next === undefined || start < next[0])) {
      next = [start, key];
    }
  }

  return next;
}

function isSensitiveKeyBoundary(lower: string, start: number): boolean {
  if (start === 0) {
    return true;
  }
  const previous = lower[start - 1];
  return !isAsciiAlphanumeric(previous) && previous !== "_";
}

function endOfSensitiveValue(text: string, start: number): number {
  const first = text[start];
  if (first === "'" || first === '"') {
    const closing = text.indexOf(first, start + 1);
    return closing < 0 ? text.length : closing + 1;
  }

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (isWhitespace(character) || character === "," || character === ";"
      || character === "&" || character === ")") {
      return index;
    }
  }
  return text.length;
}

function replaceCaseInsensitive(text: string, value: string, replacement: string): string {
  const lower = asciiLower(text);
  const valueLower = asciiLower(value);
  let result = "";
  let cursor = 0;
  let start = lower.indexOf(valueLower, cursor);

  while (start >= 0) {
    result += text.slice(cursor, start);
    result += replacement;
    cursor = start + value.length;
    start = lower.indexOf(valueLower, cursor);
  }

  return result + text.slice(cursor);
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isAsciiAlphanumeric(character: string): boolean {
  return /^[A-Za-z0-9]$/.test(character);
}

function isAsciiWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n"
    || character === "\r" || character === "\f" || character === "\v";
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}
