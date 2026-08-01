import { invoke } from "@tauri-apps/api/core";

export type CommandError = { title: string; detail: string; code: string; runId?: string; stepId?: string };

type ConnectionDto = {
  id: string; displayName: string; kind: "oracle"; host: string; port: number;
  serviceName: string; username: string; enabled: boolean;
};
type FlowDto = {
  id: string; name: string; sourceConnectionId: string; targetConnectionId: string;
  querySteps: Array<{ id: string; selectSql: string; upsertSql: string }>;
  transactionPolicy: "all_or_nothing" | "commit_successes"; version: number;
};
export type RunStatusDto = "draft" | "validating" | "completed" | "rolled_back" | "stopped_by_user" | "failed"
  | { running: { step: number } } | { awaiting_recovery: { failed_step: number } };
export type StepStatusDto = "not_run" | "failed" | "skipped_by_user" | { succeeded: { affected_rows: number } };
export type RunEventDto =
  | { type: "step_succeeded"; step: number; affected_rows: number }
  | { type: "step_failed"; step: number; error: { connector?: { code: string; message: string; retryable: boolean } } }
  | { type: "transaction_failed"; error: { connector?: { code: string; message: string; retryable: boolean } } }
  | { type: "recovery_applied"; step: number; action: "edit_and_retry" | "skip_and_continue" | "stop" };
export type RunDto = {
  runId: string; policy: "all_or_nothing" | "commit_successes"; status: RunStatusDto;
  steps: StepStatusDto[]; events: RunEventDto[];
};
type RecoverRunRequestDto =
  | { type: "edit_and_retry"; run_id: string; step_id: string; select_sql: string; upsert_sql: string }
  | { type: "skip_and_continue"; run_id: string; step_id: string }
  | { type: "stop"; run_id: string; step_id: string };

type CommandRequestMap = {
  list_connections: undefined;
  save_connection: { request: Omit<ConnectionDto, "enabled"> & { secret: string } };
  update_connection: { request: ConnectionDto & { replacementSecret?: string } };
  disable_connection: { request: { connectionId: string } };
  test_connection: { request: { connectionId: string } };
  list_flows: undefined;
  save_flow: { request: FlowDto };
  duplicate_flow: { request: { flowId: string; duplicateId: string } };
  start_run: { request: { flowId: string } };
  recover_run: { request: RecoverRunRequestDto };
  list_run_history: undefined;
};

type CommandResponseMap = {
  list_connections: ConnectionDto[];
  save_connection: ConnectionDto;
  update_connection: ConnectionDto;
  disable_connection: ConnectionDto;
  test_connection: { connectionId: string; connected: boolean };
  list_flows: FlowDto[];
  save_flow: FlowDto;
  duplicate_flow: FlowDto;
  start_run: RunDto;
  recover_run: RunDto;
  list_run_history: RunDto[];
};

export function invokeCommand<TCommand extends keyof CommandRequestMap>(
  command: TCommand,
  ...[request]: CommandRequestMap[TCommand] extends undefined ? [] : [CommandRequestMap[TCommand]]
): Promise<CommandResponseMap[TCommand]> {
  return invoke<CommandResponseMap[TCommand]>(command, request);
}
