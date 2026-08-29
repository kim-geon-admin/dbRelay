export type CommandError = { title: string; detail: string; code: string; runId?: string; stepId?: string };

type ConnectionDto = {
  id: string; displayName: string; kind: "oracle"; host: string; port: number;
  sid: string; username: string; passwordMask: string; enabled: boolean;
};
type FlowDto = {
  id: string; name: string; sourceConnectionId: string; targetConnectionId: string;
  querySteps: Array<{ id: string; title?: string; selectSql: string; upsertSql: string }>;
  transactionPolicy: "all_or_nothing" | "commit_successes"; version: number;
};
export type ImportFlowResultDto =
  | { status: "cancelled" }
  | { status: "saved"; flow: FlowDto }
  | { status: "needs_connection_selection"; flow: FlowDto };
export type PreviewOracleDateDto = {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
};
export type PreviewOracleTimestampDto = PreviewOracleDateDto & {
  microsecond: number; tzHourOffset: number; tzMinuteOffset: number;
};
export type PreviewBytesDto = { type: "bytes"; base64: string };
export type PreviewBigIntDto = { type: "bigint"; decimal: string };
export type PreviewCellDto = null | string | number | boolean | PreviewOracleDateDto
  | PreviewOracleTimestampDto | PreviewBytesDto | PreviewBigIntDto | PreviewCellDto[]
  | { [key: string]: PreviewCellDto };
export type PreviewFlowStepDto = {
  previewId: string;
  columns: string[]; rows: Array<Record<string, PreviewCellDto>>;
};
export type RunStatusDto = "draft" | "validating" | "completed" | "rolled_back" | "stopped_by_user" | "failed"
  | { running: { step: number } } | { awaiting_recovery: { failed_step: number } }
  | { recovery_pending: { failed_step: number; action: "edit_and_retry" | "skip_and_continue" | "stop" } }
  | { commit_pending: { step: number } } | { in_doubt: { step: number; reason: RunErrorDto } };
export type StepStatusDto = "not_run" | "failed" | "skipped_by_user" | { succeeded: { affected_rows: number } };
export type RunErrorDto =
  | { type: "connector"; detail: { code: string; message: string; retryable: boolean } }
  | { type: "invalid_transition"; detail: { status: RunStatusDto; action: "edit_and_retry" | "skip_and_continue" | "stop" } }
  | { type: "invalid_step"; detail: { expected: number; received: number } }
  | { type: "step_out_of_bounds"; detail: { step: number; step_count: number } };
export type RunEventDto =
  | { type: "step_succeeded"; step: number; affected_rows: number }
  | { type: "step_failed"; step: number; error: RunErrorDto }
  | { type: "transaction_failed"; error: RunErrorDto }
  | { type: "recovery_applied"; step: number; action: "edit_and_retry" | "skip_and_continue" | "stop" };
export type RunDto = {
  runId: string; policy: "all_or_nothing" | "commit_successes"; status: RunStatusDto;
  steps: StepStatusDto[]; events: RunEventDto[]; stepTitles?: string[];
};
export type RunProgressDto = {
  runId: string; step: number; processedRows: number; totalRows: number;
  completedBatches: number; totalBatches: number;
};
export type HistoryRunDto = RunDto & {
  flowId: string; flowName: string; sourceDbName: string; targetDbName: string;
  flowVersion: number; startedAt: number; endedAt: number | null;
};
type RecoverRunRequestDto =
  | { type: "edit_and_retry"; run_id: string; step_id: string; select_sql: string; upsert_sql: string }
  | { type: "skip_and_continue"; run_id: string; step_id: string }
  | { type: "stop"; run_id: string; step_id: string };

type CommandRequestMap = {
  list_connections: undefined;
  save_connection: { request: Omit<ConnectionDto, "enabled" | "passwordMask"> & { secret: string } };
  update_connection: { request: Omit<ConnectionDto, "passwordMask"> & { replacementSecret?: string } };
  disable_connection: { request: { connectionId: string } };
  test_connection: { request: { connectionId: string } };
  set_connection_enabled: { request: { connectionId: string; enabled: boolean } };
  delete_connection: { request: { connectionId: string } };
  list_flows: undefined;
  save_flow: { request: FlowDto };
  duplicate_flow: { request: { flowId: string; duplicateId: string } };
  export_flow: { request: { flowId: string } };
  delete_flow: { request: { flowId: string } };
  import_flow: undefined;
  preview_flow_step: { request: { sourceConnectionId: string; selectSql: string } };
  save_edited_preview: {
    request: { previewId: string; columns: string[]; rows: Array<Record<string, PreviewCellDto>> };
  };
  discard_edited_preview: { request: { previewId: string } };
  run_flow_step: {
    request: {
      sourceConnectionId: string; targetConnectionId: string; selectSql: string; upsertSql: string;
      previewId?: string;
      editorSessionId?: string; stepId?: string;
    };
  };
  restore_flow_step: { request: { restoreId: string } };
  discard_step_restore: { request: { restoreId: string } };
  discard_editor_restores: { request: { editorSessionId: string } };
  start_run: { request: { flowId: string } };
  recover_run: { request: RecoverRunRequestDto };
  list_run_history: undefined;
  delete_run_history: { request: { runId: string } };
  clear_run_history: undefined;
};

export type CommandResponseMap = {
  list_connections: ConnectionDto[];
  save_connection: ConnectionDto;
  update_connection: ConnectionDto;
  disable_connection: ConnectionDto;
  test_connection: { connectionId: string; connected: boolean };
  set_connection_enabled: ConnectionDto;
  delete_connection: undefined;
  list_flows: FlowDto[];
  save_flow: FlowDto;
  duplicate_flow: FlowDto;
  export_flow: { exported: boolean };
  delete_flow: undefined;
  import_flow: ImportFlowResultDto;
  preview_flow_step: PreviewFlowStepDto;
  save_edited_preview: undefined;
  discard_edited_preview: undefined;
  run_flow_step: { affectedRows: number; restoreId?: string };
  restore_flow_step: { affectedRows: number };
  discard_step_restore: undefined;
  discard_editor_restores: undefined;
  start_run: RunDto;
  recover_run: RunDto;
  list_run_history: HistoryRunDto[];
  delete_run_history: undefined;
  clear_run_history: { deletedCount: number };
};

export function invokeCommand<TCommand extends keyof CommandRequestMap>(
  command: TCommand,
  ...[request]: CommandRequestMap[TCommand] extends undefined ? [] : [CommandRequestMap[TCommand]]
): Promise<CommandResponseMap[TCommand]> {
  return window.dbRelay.invoke(command, request) as Promise<CommandResponseMap[TCommand]>;
}

export function subscribeToRunProgress(listener: (progress: RunProgressDto) => void): () => void {
  return window.dbRelay.subscribeRunProgress(listener);
}
