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

type CommandRequestMap = {
  list_connections: undefined;
  save_connection: { request: Omit<ConnectionDto, "enabled"> & { secret: string } };
  update_connection: { request: ConnectionDto & { replacementSecret?: string } };
  disable_connection: { request: { connectionId: string } };
  test_connection: { request: { connectionId: string } };
  list_flows: undefined;
  save_flow: { request: FlowDto };
  duplicate_flow: { request: { flowId: string; duplicateId: string } };
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
};

export function invokeCommand<TCommand extends keyof CommandRequestMap>(
  command: TCommand,
  ...[request]: CommandRequestMap[TCommand] extends undefined ? [] : [CommandRequestMap[TCommand]]
): Promise<CommandResponseMap[TCommand]> {
  return invoke<CommandResponseMap[TCommand]>(command, request);
}

