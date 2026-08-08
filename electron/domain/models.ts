export type DbKind = "oracle";
export type CredentialStorage = "keyring" | "plaintext";

export interface ConnectionProfile {
  id: string;
  displayName: string;
  kind: DbKind;
  host: string;
  port: number;
  sid: string;
  username: string;
  credentialRef: string;
  credentialStorage: CredentialStorage;
  plaintextPassword?: string | null;
  enabled: boolean;
  sourceReadOnly: boolean;
}

export type TransactionPolicy = "all_or_nothing" | "commit_successes";

export interface QueryStep {
  id: string;
  selectSql: string;
  upsertSql: string;
}

export interface Flow {
  id: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  querySteps: QueryStep[];
  transactionPolicy: TransactionPolicy;
  version: number;
}

export interface OracleDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface OracleTimestamp extends OracleDate {
  microsecond: number;
  tzHourOffset: number;
  tzMinuteOffset: number;
}

export type DomainValue =
  | null
  | string
  | number
  | bigint
  | boolean
  | OracleDate
  | OracleTimestamp
  | Uint8Array;

export type Row = Record<string, DomainValue>;
export type NamedRow = Record<string, DomainValue>;

export interface RowSet {
  columns: string[];
  unsupportedBindColumns: string[];
  rows: Row[];
}

export type RecoveryAction = "edit_and_retry" | "skip_and_continue" | "stop";

export interface ConnectorErrorData {
  code: string;
  message: string;
  retryable: boolean;
}

export type RunErrorData =
  | { type: "connector"; detail: ConnectorErrorData }
  | {
    type: "invalid_transition";
    detail: { status: RunStatus; action: RecoveryAction };
  }
  | { type: "invalid_step"; detail: { expected: number; received: number } }
  | { type: "step_out_of_bounds"; detail: { step: number; step_count: number } };

export type RunStatus =
  | "draft"
  | "validating"
  | "completed"
  | "rolled_back"
  | "stopped_by_user"
  | "failed"
  | { running: { step: number } }
  | { awaiting_recovery: { failed_step: number } }
  | { recovery_pending: { failed_step: number; action: RecoveryAction } }
  | { commit_pending: { step: number } }
  | { in_doubt: { step: number; reason: RunErrorData } };

export type StepStatus =
  | "not_run"
  | "failed"
  | "skipped_by_user"
  | { succeeded: { affected_rows: number } };

export interface RunStep {
  status: StepStatus;
}

export type RunEvent =
  | { type: "step_succeeded"; step: number; affected_rows: number }
  | { type: "step_failed"; step: number; error: RunErrorData }
  | { type: "transaction_failed"; error: RunErrorData }
  | { type: "recovery_applied"; step: number; action: RecoveryAction };

export interface RunStateData {
  policy: TransactionPolicy;
  status: RunStatus;
  steps: RunStep[];
  events: RunEvent[];
}
