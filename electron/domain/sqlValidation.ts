export type DbKind = "oracle";

export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

const PROHIBITED_TOKENS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "BEGIN",
  "DECLARE",
  "EXECUTE",
]);

const SOURCE_WRITE_TOKENS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "LOCK"]);

export function validateSourceStatement(sql: string): void {
  validateStatement(sql, true);
}

export function validateTargetStatement(kind: DbKind, sql: string): void {
  if (kind === "oracle") {
    validateStatement(sql, false);
  }
}

function validateStatement(sql: string, source: boolean): void {
  const lexical = lexicalSql(sql);
  const tokens = lexical
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());

  const first = tokens[0];
  const hasExpectedFirstKeyword = source
    ? first === "SELECT" || first === "WITH"
    : first === "INSERT" || first === "UPDATE" || first === "MERGE";

  if (!hasExpectedFirstKeyword) {
    throw new SqlValidationError(source
      ? "source SQL must begin with SELECT or WITH"
      : "Oracle target SQL must begin with INSERT, UPDATE, or MERGE");
  }

  const containsSetTransaction = tokens.some(
    (token, index) => token === "SET" && tokens[index + 1] === "TRANSACTION",
  );
  if (tokens.some((token) => PROHIBITED_TOKENS.has(token)) || containsSetTransaction) {
    throw new SqlValidationError(
      "SQL contains a prohibited administrative, transaction, or PL/SQL statement",
    );
  }

  if (source && tokens.some((token) => SOURCE_WRITE_TOKENS.has(token))) {
    throw new SqlValidationError("source SQL must be read-only");
  }

  if (/:[0-9]/.test(lexical)) {
    throw new SqlValidationError("numeric bind placeholders are not supported");
  }
}

function lexicalSql(sql: string): string {
  const lexical = Array.from({ length: sql.length }, () => " ");
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const next = skipQuoted(sql, index);
      if (next === sql.length && sql[sql.length - 1] !== character) {
        throw new SqlValidationError("SQL contains an unterminated quoted literal");
      }
      index = next;
    } else if (character === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index + 2);
    } else if (character === "/" && sql[index + 1] === "*") {
      const next = skipBlockComment(sql, index + 2);
      if (next === sql.length && !sql.endsWith("*/")) {
        throw new SqlValidationError("SQL contains an unterminated block comment");
      }
      index = next;
    } else {
      lexical[index] = character;
      index += 1;
    }
  }

  const value = lexical.join("");
  const semicolon = value.indexOf(";");
  if (semicolon >= 0 && /\S/u.test(value.slice(semicolon + 1))) {
    throw new SqlValidationError("multiple SQL statements are not supported");
  }
  return value;
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
