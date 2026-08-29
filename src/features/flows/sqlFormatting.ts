import { format } from "sql-formatter";

export function formatOracleSql(sql: string): string {
  return format(sql, { language: "plsql", keywordCase: "upper", tabWidth: 2 });
}
