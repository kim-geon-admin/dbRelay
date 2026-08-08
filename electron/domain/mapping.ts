import type { DomainValue, NamedRow, Row } from "./models";

export type SourceRow = Row;
export type { NamedRow } from "./models";

export class MappingError extends Error {
  readonly kind: "missing_source_column" | "duplicate_source_column" | "numeric_bind";
  readonly parameter: string;

  private constructor(
    kind: MappingError["kind"],
    parameter: string,
    message: string,
  ) {
    super(message);
    this.name = "MappingError";
    this.kind = kind;
    this.parameter = parameter;
  }

  static missingSourceColumn(parameter: string): MappingError {
    return new MappingError(
      "missing_source_column",
      parameter,
      `missing source column: ${parameter}`,
    );
  }

  static duplicateSourceColumn(column: string): MappingError {
    return new MappingError(
      "duplicate_source_column",
      column,
      `duplicate source column: ${column}`,
    );
  }

  static numericBind(parameter: string): MappingError {
    return new MappingError(
      "numeric_bind",
      parameter,
      `numeric bind placeholder is not supported: ${parameter}`,
    );
  }
}

export function extractNamedBinds(sql: string): string[] {
  const binds: string[] = [];
  const seen = new Set<string>();
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'" || character === '"') {
      index = skipQuoted(sql, index);
    } else if (character === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index + 2);
    } else if (character === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index + 2);
    } else if (character === ":") {
      const start = index + 1;
      const next = sql[start];

      if (next !== undefined && isBindStart(next)) {
        let end = start + 1;
        while (end < sql.length && isBindContinue(sql[end])) {
          end += 1;
        }

        const bind = sql.slice(start, end);
        const normalized = asciiUpper(bind);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          binds.push(bind);
        }
        index = end;
      } else if (next !== undefined && isAsciiDigit(next)) {
        let end = start + 1;
        while (end < sql.length && isAsciiDigit(sql[end])) {
          end += 1;
        }
        throw MappingError.numericBind(sql.slice(start, end));
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }

  return binds;
}

export function mapRow(row: SourceRow, bindNames: readonly string[]): NamedRow {
  const normalized = new Map<string, DomainValue>();

  for (const [column, value] of Object.entries(row)) {
    const normalizedColumn = asciiUpper(column);
    if (normalized.has(normalizedColumn)) {
      throw MappingError.duplicateSourceColumn(normalizedColumn);
    }
    normalized.set(normalizedColumn, value);
  }

  const mapped = Object.create(null) as NamedRow;
  for (const bind of bindNames) {
    const normalizedBind = asciiUpper(bind);
    if (!normalized.has(normalizedBind)) {
      throw MappingError.missingSourceColumn(bind);
    }
    mapped[bind] = normalized.get(normalizedBind) as DomainValue;
  }
  return mapped;
}

function isBindStart(character: string): boolean {
  return isAsciiLetter(character) || character === "_";
}

function isBindContinue(character: string): boolean {
  return isBindStart(character)
    || isAsciiDigit(character)
    || character === "$"
    || character === "#";
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function asciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function skipQuoted(sql: string, start: number): number {
  const quote = sql[start];
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
      } else {
        return index + 1;
      }
    } else {
      index += 1;
    }
  }

  return index;
}

function skipLineComment(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && sql[index] !== "\n") {
    index += 1;
  }
  return index;
}

function skipBlockComment(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (sql[index] === "*" && sql[index + 1] === "/") {
      return index + 2;
    }
    index += 1;
  }
  return index;
}
