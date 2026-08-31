import type {
  ConnectionProfile,
  DbKind,
  NamedRow,
  RowSet,
} from "../domain/models";

export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export type TargetColumnKind = "numeric" | "text";

export interface DatabaseSession {
  query(sql: string): Promise<RowSet>;
  queryNamed?(sql: string, rows: readonly NamedRow[]): Promise<RowSet>;
  describeTargetColumns?(
    table: string,
    columns: readonly string[],
  ): Promise<Record<string, TargetColumnKind>>;
  begin(): Promise<void>;
  executeNamed(sql: string, rows: readonly NamedRow[]): Promise<number>;
  executeNamedReturningRowIds?(sql: string, rows: readonly NamedRow[]): Promise<{
    affectedRows: number;
    rowIds: string[];
  }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseConnectorFactory {
  readonly kind: DbKind;
  open(profile: ConnectionProfile, secret: string): Promise<DatabaseSession>;
}
