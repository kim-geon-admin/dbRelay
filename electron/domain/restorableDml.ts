export type RestorableDmlPlan = {
  kind: "insert" | "update" | "upsert";
  table: string;
  keyTerms: Array<{ column: string; bindName: string }>;
  assignedColumns: string[];
};

const identifierSource = String.raw`(?:[\p{L}_][\p{L}\p{M}\p{Nd}_$#]*|"(?:[^"]|"")+")`;
const qualifiedIdentifierSource = String.raw`${identifierSource}(?:\.${identifierSource})*`;
const bindSource = String.raw`[\p{L}_][\p{L}\p{M}\p{Nd}_$#]*`;
const identifier = new RegExp(`^${identifierSource}$`, "u");

export function parseRestorableDml(sql: string): RestorableDmlPlan | undefined {
  const compact = stripSqlComments(sql).replace(/\s+/gu, " ").trim();
  return parseUpdate(compact) ?? parseInsert(compact) ?? parseMerge(compact);
}

function parseUpdate(sql: string): RestorableDmlPlan | undefined {
  const match = new RegExp(`^UPDATE (${qualifiedIdentifierSource}) SET (.+) WHERE (.+)$`, "iu").exec(sql);
  if (match === null) return undefined;
  const assignedColumns = assignmentColumns(match[2], "");
  const keyTerms = equalityTerms(match[3], "", "");
  return assignedColumns === undefined || keyTerms === undefined
    ? undefined
    : { kind: "update", table: match[1], keyTerms, assignedColumns };
}

function parseInsert(sql: string): RestorableDmlPlan | undefined {
  const match = new RegExp(
    `^INSERT INTO (${qualifiedIdentifierSource}) \\(([^)]+)\\) VALUES \\(([^)]+)\\)$`,
    "iu",
  ).exec(sql);
  if (match === null) return undefined;
  const columns = commaSeparatedIdentifiers(match[2]);
  const values = match[3].split(",").map((value) => value.trim());
  if (columns === undefined || columns.length !== values.length
    || !values.every((value) => new RegExp(`^:${bindSource}$`, "u").test(value))) return undefined;
  return { kind: "insert", table: match[1], keyTerms: [], assignedColumns: columns };
}

function parseMerge(sql: string): RestorableDmlPlan | undefined {
  const match = new RegExp(
    `^MERGE INTO (${qualifiedIdentifierSource}) target USING \\(SELECT (.+) FROM dual\\) source ON \\((.+)\\)(?: WHEN MATCHED THEN UPDATE SET (.+?))? WHEN NOT MATCHED THEN INSERT \\(([^)]+)\\) VALUES \\(([^)]+)\\)$`,
    "iu",
  ).exec(sql);
  if (match === null) return undefined;
  const projectionBinds = projectionBindNames(match[2]);
  const keyTerms = equalityTerms(match[3], "target.", "source.", projectionBinds);
  const updated = match[4] === undefined ? [] : assignmentColumns(match[4], "target.", "source.");
  const inserted = commaSeparatedIdentifiers(match[5]);
  const insertValues = match[6].split(",").map((value) => value.trim());
  if (projectionBinds === undefined || keyTerms === undefined || updated === undefined || inserted === undefined
    || inserted.length !== insertValues.length
    || !inserted.every((column, index) => sourceValueMatches(column, insertValues[index], projectionBinds))) {
    return undefined;
  }
  return {
    kind: "upsert",
    table: match[1],
    keyTerms,
    assignedColumns: uniqueIdentifiers([...updated, ...inserted]),
  };
}

function projectionBindNames(value: string): Map<string, string> | undefined {
  const result = new Map<string, string>();
  for (const item of value.split(",").map((item) => item.trim())) {
    const match = new RegExp(`^:(${bindSource}) (${identifierSource})$`, "u").exec(item);
    if (match === null) return undefined;
    const key = identifierKey(match[2]);
    if (result.has(key)) return undefined;
    result.set(key, match[1]);
  }
  return result.size === 0 ? undefined : result;
}

function equalityTerms(
  value: string,
  leftPrefix: string,
  rightPrefix: string,
  projectionBinds?: ReadonlyMap<string, string>,
): Array<{ column: string; bindName: string }> | undefined {
  const terms = value.split(/\s+AND\s+/iu);
  if (terms.length === 0) return undefined;
  const result: Array<{ column: string; bindName: string }> = [];
  for (const item of terms) {
    const right = rightPrefix === "" ? `:(${bindSource})` : `(${identifierSource})`;
    const match = new RegExp(
      `^${escapeRegExp(leftPrefix)}(${identifierSource}) = ${escapeRegExp(rightPrefix)}${right}$`,
      "iu",
    ).exec(item.trim());
    if (match === null) return undefined;
    const bindName = rightPrefix === "" ? match[2] : projectionBinds?.get(identifierKey(match[2]));
    if (bindName === undefined) return undefined;
    result.push({ column: match[1], bindName });
  }
  return uniqueKeyTerms(result);
}

function assignmentColumns(value: string, targetPrefix: string, sourcePrefix?: string): string[] | undefined {
  const result: string[] = [];
  for (const item of value.split(",").map((item) => item.trim())) {
    const right = sourcePrefix === undefined
      ? `:${bindSource}`
      : `${escapeRegExp(sourcePrefix)}${identifierSource}`;
    const match = new RegExp(`^${escapeRegExp(targetPrefix)}(${identifierSource}) = ${right}$`, "iu").exec(item);
    if (match === null) return undefined;
    result.push(match[1]);
  }
  return uniqueIdentifiers(result);
}

function commaSeparatedIdentifiers(value: string): string[] | undefined {
  const identifiers = value.split(",").map((item) => item.trim());
  return identifiers.length > 0 && identifiers.every((item) => identifier.test(item))
    ? uniqueIdentifiers(identifiers)
    : undefined;
}

function sourceValueMatches(
  _column: string,
  value: string | undefined,
  projectionBinds: ReadonlyMap<string, string>,
): boolean {
  if (value === undefined) return false;
  const match = new RegExp(`^source\\.(${identifierSource})$`, "iu").exec(value);
  return match !== null && projectionBinds.has(identifierKey(match[1]));
}

function uniqueIdentifiers(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = identifierKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueKeyTerms(values: readonly { column: string; bindName: string }[]) {
  const seen = new Set<string>();
  const unique: Array<{ column: string; bindName: string }> = [];
  for (const value of values) {
    const key = identifierKey(value.column);
    if (seen.has(key)) return undefined;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function identifierKey(value: string): string {
  const unquoted = value.startsWith('"') ? value.slice(1, -1).replace(/""/gu, '"') : value;
  return unquoted.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripSqlComments(sql: string): string {
  let result = "";
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const quote = character;
      result += character;
      index += 1;
      while (index < sql.length) {
        const quoted = sql[index];
        result += quoted;
        index += 1;
        if (quoted === quote) {
          if (sql[index] === quote) { result += quote; index += 1; }
          else break;
        }
      }
    } else if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      result += " ";
      index = end === -1 ? sql.length : end + 1;
    } else if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) return sql;
      result += " ";
      index = end + 2;
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}
