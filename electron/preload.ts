import { contextBridge, ipcRenderer } from "electron";

import {
  DB_RELAY_CHANNEL,
  type CommandArguments,
  type CommandErrorDto,
  type CommandResponseMap,
  type DbRelayApi,
  type DbRelayCommand,
  type DbRelayIpcResult,
  isDbRelayCommand,
} from "./ipc/commands";

type IpcInvoke = (channel: string, command: string, request?: unknown) => Promise<unknown>;

export function isAllowedCommand(command: string): boolean {
  return isDbRelayCommand(command);
}

export function invokeDbRelayCommand<Command extends DbRelayCommand>(
  invoke: IpcInvoke,
  command: Command,
  ...args: CommandArguments<Command>
): Promise<CommandResponseMap[Command]>;
export function invokeDbRelayCommand(
  invoke: IpcInvoke,
  command: string,
  request?: unknown,
): Promise<unknown>;
export async function invokeDbRelayCommand(
  invoke: IpcInvoke,
  command: string,
  request?: unknown,
): Promise<unknown> {
  if (!isDbRelayCommand(command)) {
    throw commandNotAllowed();
  }

  let result: unknown;
  try {
    result = await invoke(DB_RELAY_CHANNEL, command, request);
  } catch {
    throw ipcUnavailable();
  }
  if (!isIpcResult(result)) {
    throw invalidIpcResponse();
  }
  if (!result.ok) {
    throw projectCommandError(result.error);
  }
  return result.value;
}

const dbRelay: DbRelayApi = {
  invoke<Command extends DbRelayCommand>(
    command: Command,
    ...args: CommandArguments<Command>
  ): Promise<CommandResponseMap[Command]> {
    return invokeDbRelayCommand(ipcRenderer.invoke.bind(ipcRenderer), command, ...args);
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("dbRelay", dbRelay);
}

function isIpcResult(value: unknown): value is DbRelayIpcResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    return "value" in value;
  }
  return value.ok === false && "error" in value && isCommandError(value.error);
}

function isCommandError(value: unknown): value is CommandErrorDto {
  return typeof value === "object"
    && value !== null
    && "title" in value
    && typeof value.title === "string"
    && "detail" in value
    && typeof value.detail === "string"
    && "code" in value
    && typeof value.code === "string";
}

function commandNotAllowed(): CommandErrorDto {
  return {
    title: "Request could not be completed",
    detail: "The requested command is not available.",
    code: "COMMAND_NOT_ALLOWED",
  };
}

function invalidIpcResponse(): CommandErrorDto {
  return {
    title: "Request could not be completed",
    detail: "The application returned an invalid response.",
    code: "INVALID_IPC_RESPONSE",
  };
}

function ipcUnavailable(): CommandErrorDto {
  return {
    title: "Request could not be completed",
    detail: "The application command channel is unavailable.",
    code: "IPC_UNAVAILABLE",
  };
}

function projectCommandError(error: CommandErrorDto): CommandErrorDto {
  return {
    title: error.title,
    detail: error.detail,
    code: error.code,
    ...(typeof error.runId === "string" ? { runId: error.runId } : {}),
    ...(typeof error.stepId === "string" ? { stepId: error.stepId } : {}),
  };
}
