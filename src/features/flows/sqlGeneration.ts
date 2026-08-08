export type TargetOperation = "insert" | "update";

type SourceShape = {
  table: string;
  columns: string[];
};

const identifier = "[A-Za-z_][A-Za-z0-9_$#]*";
const qualifiedIdentifier = new RegExp(`^(?:${identifier}\\.)*${identifier}$`);

export function targetOperationForSql(targetSql: string): TargetOperation {
  const keyword = firstKeyword(targetSql);
  return keyword === "UPDATE" || keyword === "MERGE" ? "update" : "insert";
}

export function generateTargetSql(operation: TargetOperation, sourceSql: string): string {
  const source = parseSimpleSelect(sourceSql);
  if (!source) return "";

  if (operation === "insert") {
    return `INSERT INTO ${source.table} (${source.columns.join(", ")})\nVALUES (${source.columns.map((column) => `:${column}`).join(", ")})`;
  }

  const [key, ...updatableColumns] = source.columns;
  const assignments = (updatableColumns.length ? updatableColumns : [key])
    .map((column) => `  ${column} = :${column}`)
    .join(",\n");
  return `-- Review the WHERE clause and use the target table primary key.\nUPDATE ${source.table}\nSET\n${assignments}\nWHERE ${key} = :${key}`;
}

function parseSimpleSelect(sql: string): SourceShape | undefined {
  const match = sql.match(new RegExp(`^\\s*SELECT\\s+([\\s\\S]+?)\\s+FROM\\s+(${identifier}(?:\\.${identifier})*)(?:\\s|$)`, "i"));
  if (!match) return undefined;

  const columns = match[1]
    .split(",")
    .map((projection) => projection.trim())
    .map(columnNameForProjection);
  if (columns.some((column) => !column) || new Set(columns.map((column) => column!.toUpperCase())).size !== columns.length) return undefined;

  return { table: match[2], columns: columns as string[] };
}

function columnNameForProjection(projection: string): string | undefined {
  const alias = projection.match(new RegExp(`\\s+AS\\s+(${identifier})$`, "i"))
    ?? projection.match(new RegExp(`\\s+(${identifier})$`, "i"));
  if (alias) return alias[1];

  if (!qualifiedIdentifier.test(projection)) return undefined;
  const parts = projection.split(".");
  return parts[parts.length - 1];
}

function firstKeyword(sql: string): string | undefined {
  const withoutLeadingComments = sql.replace(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/i, "");
  return withoutLeadingComments.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
}
