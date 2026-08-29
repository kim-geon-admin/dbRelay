export type TargetOperation = "insert" | "update" | "upsert";

type SourceColumn = { sql: string; bindName: string };
type SourceShape = { table: string; columns: SourceColumn[] };
const identifier = "(?:[\\p{L}_][\\p{L}\\p{M}\\p{Nd}_$#]*|\"(?:[^\"]|\"\")+\")";
const qualifiedIdentifier = new RegExp(`^(?:${identifier}\\.)*${identifier}$`, "u");
const validBindName = /^[\p{L}_][\p{L}\p{M}\p{Nd}_$#]*$/u;

export function targetOperationForSql(targetSql: string): TargetOperation {
  const keyword = firstKeyword(targetSql);
  return keyword === "UPDATE" ? "update" : keyword === "MERGE" ? "upsert" : "insert";
}

export function generateTargetSql(operation: TargetOperation, sourceSql: string): string {
  const source = parseSimpleSelect(sourceSql);
  if (!source) return "";
  if (operation === "insert") {
    return `INSERT INTO ${source.table} (${source.columns.map((column) => column.sql).join(", ")})\nVALUES (${source.columns.map((column) => `:${column.bindName}`).join(", ")})`;
  }
  if (operation === "upsert") {
    const keys = source.columns.slice(0, 1);
    const updateColumns = source.columns.filter((column) => !keys.some((key) => key.bindName.toUpperCase() === column.bindName.toUpperCase()));
    const projection = source.columns.map((column) => `:${column.bindName} ${column.sql}`).join(", ");
    const on = keys.map((key) => `target.${key.sql} = source.${key.sql}`).join(" AND ");
    const update = updateColumns.length ? `\nWHEN MATCHED THEN UPDATE SET\n${updateColumns.map((column) => `  target.${column.sql} = source.${column.sql}`).join(",\n")}` : "";
    const guide = [
      `-- [가이드] Source SQL의 첫 번째 컬럼(${keys[0]?.sql})을 대상 행 검색 ON 조건으로 사용합니다.`,
      `-- [가이드] ${source.columns.map((column) => `:${column.bindName}`).join(", ")} 값은 Source SQL의 SELECT 컬럼 값으로 자동 바인딩됩니다.`,
      "-- [가이드] ON 조건은 대상 테이블의 실제 PK/UK 조건에 맞게 반드시 검토·수정하세요.",
      "-- [가이드] WHEN MATCHED THEN: 기존 행을 UPDATE합니다.",
      "-- [가이드] WHEN NOT MATCHED THEN: 새 행을 INSERT합니다.",
    ].join("\n");
    return `${guide}\nMERGE INTO ${source.table} target\nUSING (SELECT ${projection} FROM dual) source\nON (${on})${update}\nWHEN NOT MATCHED THEN INSERT (${source.columns.map((column) => column.sql).join(", ")})\nVALUES (${source.columns.map((column) => `source.${column.sql}`).join(", ")})`;
  }
  const keys = source.columns.slice(0, 1);
  const updateColumns = source.columns.slice(1).length ? source.columns.slice(1) : source.columns.slice(0, 1);
  const assignments = updateColumns.map((column) => `  ${column.sql} = :${column.bindName}`).join(",\n");
  const where = keys.length ? `\nWHERE ${keys.map((key) => `${key.sql} = :${key.bindName}`).join(" AND ")}` : "";
  return `-- [가이드] Source SQL의 첫 번째 컬럼(${keys[0]?.sql})을 WHERE 조건으로 사용합니다. 실제 키 조건에 맞게 수정하세요.\nUPDATE ${source.table}\nSET\n${assignments}${where}`;
}

function parseSimpleSelect(sql: string): SourceShape | undefined {
  const match = sql.match(new RegExp(`^\\s*SELECT\\s+([\\s\\S]+?)\\s+FROM\\s+(${identifier}(?:\\.${identifier})*)(?:\\s|$)`, "iu"));
  if (!match) return undefined;
  const columns = match[1].split(",").map((projection) => projection.trim()).map(columnNameForProjection);
  if (columns.some((column) => !column) || new Set(columns.map((column) => column!.bindName.toUpperCase())).size !== columns.length) return undefined;
  return { table: match[2], columns: columns as SourceColumn[] };
}

function columnNameForProjection(projection: string): SourceColumn | undefined {
  const alias = projection.match(new RegExp(`\\s+AS\\s+(${identifier})$`, "iu")) ?? projection.match(new RegExp(`\\s+(${identifier})$`, "iu"));
  if (alias) {
    const sourceExpression = projection.slice(0, alias.index).trim();
    if (!qualifiedIdentifier.test(sourceExpression)) return undefined;
    return sourceColumn(lastIdentifier(sourceExpression), alias[1]);
  }
  if (!qualifiedIdentifier.test(projection)) return undefined;
  const columnIdentifier = lastIdentifier(projection);
  return sourceColumn(columnIdentifier, columnIdentifier);
}

function sourceColumn(sql: string, bindSource: string): SourceColumn | undefined {
  const bindName = bindSource.startsWith('"') ? bindSource.slice(1, -1).replace(/""/gu, '"') : bindSource;
  if (!validBindName.test(bindName)) return undefined;
  return { sql, bindName };
}

function lastIdentifier(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] ?? qualified;
}

function firstKeyword(sql: string): string | undefined {
  const withoutLeadingComments = sql.replace(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/i, "");
  return withoutLeadingComments.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
}
