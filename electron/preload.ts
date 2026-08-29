import { contextBridge, ipcRenderer } from "electron";

import {
  DB_RELAY_CHANNEL,
  DB_RELAY_RUN_PROGRESS_CHANNEL,
  type CommandArguments,
  type CommandErrorDto,
  type CommandResponseMap,
  type DbRelayApi,
  type DbRelayCommand,
  type DbRelayIpcResult,
  type RunProgressDto,
  isDbRelayCommand,
} from "./ipc/commands";

type IpcInvoke = (channel: string, command: string, request?: unknown) => Promise<unknown>;

type IpcProgressRenderer = {
  on(channel: string, listener: (event: unknown, progress: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, progress: unknown) => void): unknown;
};

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

export function subscribeRunProgress(
  progressRenderer: IpcProgressRenderer,
  listener: (progress: RunProgressDto) => void,
): () => void {
  const receive = (_event: unknown, value: unknown) => {
    const progress = parseRunProgress(value);
    if (progress !== undefined) listener(progress);
  };
  progressRenderer.on(DB_RELAY_RUN_PROGRESS_CHANNEL, receive);
  return () => {
    progressRenderer.removeListener(DB_RELAY_RUN_PROGRESS_CHANNEL, receive);
  };
}

const dbRelay: DbRelayApi = {
  invoke<Command extends DbRelayCommand>(
    command: Command,
    ...args: CommandArguments<Command>
  ): Promise<CommandResponseMap[Command]> {
    return invokeDbRelayCommand(ipcRenderer.invoke.bind(ipcRenderer), command, ...args);
  },
  subscribeRunProgress(listener: (progress: RunProgressDto) => void): () => void {
    return subscribeRunProgress(ipcRenderer, listener);
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

function parseRunProgress(value: unknown): RunProgressDto | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const progress = value as Record<string, unknown>;
  const keys = ["runId", "step", "processedRows", "totalRows", "completedBatches", "totalBatches"];
  if (Object.keys(progress).length !== keys.length || !keys.every((key) => key in progress)
    || typeof progress.runId !== "string" || progress.runId.length === 0
    || !isNonNegativeSafeInteger(progress.step)
    || !isNonNegativeSafeInteger(progress.processedRows)
    || !isNonNegativeSafeInteger(progress.totalRows)
    || !isNonNegativeSafeInteger(progress.completedBatches)
    || !isNonNegativeSafeInteger(progress.totalBatches)
    || progress.processedRows > progress.totalRows
    || progress.completedBatches > progress.totalBatches) {
    return undefined;
  }
  return {
    runId: progress.runId,
    step: progress.step,
    processedRows: progress.processedRows,
    totalRows: progress.totalRows,
    completedBatches: progress.completedBatches,
    totalBatches: progress.totalBatches,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
