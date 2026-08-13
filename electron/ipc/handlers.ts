import type { HistoryService } from "../application/historyService";
import { MigrationRunnerError, type MigrationRunner, type RecoveryRequest } from "../application/migrationRunner";
import { FlowServiceError, type FlowService } from "../application/flowService";
import { SettingsServiceError, type SettingsService } from "../application/settingsService";
import { ConnectorError, type ConnectorRegistry } from "../connectors/registry";
import type {
  ConnectionProfile,
  Flow,
  RunErrorData,
  RunEvent,
  RunStatus,
  StepStatus,
} from "../domain/models";
import { RepositoryError } from "../infrastructure/sqliteRepository";
import {
  DB_RELAY_CHANNEL,
  type CommandErrorDto,
  type CommandRequestMap,
  type CommandResponseMap,
  type ConnectionDto,
  type DbRelayCommand,
  type DbRelayIpcResult,
  type FlowDto,
  type HistoryRunDto,
  isDbRelayCommand,
  type RecoverRunRequestDto,
  type RunDto,
  type RunErrorDto,
  type RunEventDto,
  type RunStatusDto,
  type StepStatusDto,
} from "./commands";

type SettingsBoundary = Pick<
  SettingsService,
  | "saveConnection"
  | "updateConnection"
  | "listConnections"
  | "listConnectionDtos"
  | "disableConnection"
  | "setConnectionEnabled"
  | "deleteConnection"
  | "testConnection"
>;

export interface DbRelayServices {
  settings: SettingsBoundary;
  flows: Pick<FlowService, "saveFlow" | "listFlows" | "duplicateFlow">;
  runs: Pick<MigrationRunner, "startRun" | "recoverRun">;
  history: Pick<HistoryService, "listRunHistory">;
  connectors: Pick<ConnectorRegistry, "forKind">;
}

export interface DbRelayCommandHandler {
  <Command extends DbRelayCommand>(
    command: Command,
    request?: CommandRequestMap[Command],
  ): Promise<CommandResponseMap[Command]>;
  (command: string, request?: unknown): Promise<unknown>;
}

export interface IpcMainRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, command: unknown, request?: unknown) => Promise<DbRelayIpcResult>,
  ): void;
}

const projectedCommandError = Symbol("projected DB Relay command error");

export function createDbRelayCommandHandler(services: DbRelayServices): DbRelayCommandHandler {
  const dispatch = async (command: string, request?: unknown): Promise<unknown> => {
    if (!isDbRelayCommand(command)) {
      throw commandNotAllowed();
    }

    try {
      switch (command) {
        case "list_connections":
          return (await services.settings.listConnectionDtos()).map(projectConnection);
        case "save_connection": {
          const input = requestFor(command, request).request;
          const profile = newConnectionProfile(input);
          await services.settings.saveConnection(profile);
          return findConnection(await services.settings.listConnectionDtos(), profile.id);
        }
        case "update_connection": {
          const input = requestFor(command, request).request;
          await services.settings.updateConnection(updatedConnectionProfile(input), input.replacementSecret);
          return findConnection(await services.settings.listConnectionDtos(), input.id);
        }
        case "disable_connection": {
          const input = requestFor(command, request).request;
          await services.settings.disableConnection(input.connectionId);
          return findConnection(await services.settings.listConnectionDtos(), input.connectionId);
        }
        case "set_connection_enabled": {
          const input = requestFor(command, request).request;
          await services.settings.setConnectionEnabled(input.connectionId, input.enabled);
          return findConnection(await services.settings.listConnectionDtos(), input.connectionId);
        }
        case "delete_connection": {
          const input = requestFor(command, request).request;
          await services.settings.deleteConnection(input.connectionId);
          return undefined;
        }
        case "test_connection": {
          const input = requestFor(command, request).request;
          const profile = (await services.settings.listConnections())
            .find((candidate) => candidate.id === input.connectionId);
          if (profile === undefined) {
            throw serviceError("CONNECTION_NOT_FOUND", "connection not found");
          }
          await services.settings.testConnection(
            input.connectionId,
            services.connectors.forKind(profile.kind),
          );
          return { connectionId: input.connectionId, connected: true };
        }
        case "list_flows":
          return (await services.flows.listFlows()).map(projectFlow);
        case "save_flow":
          return projectFlow(await services.flows.saveFlow(requestFor(command, request).request));
        case "duplicate_flow": {
          const input = requestFor(command, request).request;
          return projectFlow(await services.flows.duplicateFlow(input.flowId, input.duplicateId));
        }
        case "start_run":
          return projectRun(await services.runs.startRun(requestFor(command, request).request.flowId));
        case "recover_run": {
          const input = requestFor(command, request).request;
          try {
            return projectRun(await services.runs.recoverRun(recoveryRequest(input)));
          } catch (error) {
            throw projectCommandError(error, {
              runId: input.run_id,
              stepId: input.step_id,
            });
          }
        }
        case "list_run_history":
          return (await services.history.listRunHistory()).map(projectHistoryRun);
      }
      const exhaustiveCommand: never = command;
      return exhaustiveCommand;
    } catch (error) {
      throw projectCommandError(error);
    }
  };

  return dispatch as DbRelayCommandHandler;
}

export function registerDbRelayIpc(
  ipcMain: IpcMainRegistrar,
  services: DbRelayServices,
  isTrustedSender: (event: unknown) => boolean,
): void {
  const handler = createDbRelayCommandHandler(services);
  ipcMain.handle(DB_RELAY_CHANNEL, async (event, command, request) => {
    if (!isTrustedSender(event)) {
      return {
        ok: false,
        error: {
          title: "Request could not be completed",
          detail: "The command sender is not trusted.",
          code: "IPC_SENDER_NOT_ALLOWED",
        },
      };
    }
    if (!isDbRelayCommand(command)) {
      return { ok: false, error: commandNotAllowed() };
    }
    try {
      return { ok: true, value: await handler(command, request as never) };
    } catch (error) {
      return { ok: false, error: projectCommandError(error) };
    }
  });
}

export function isTrustedIpcSender(
  event: unknown,
  trustedSenders: ReadonlySet<unknown>,
  approvedUrl: string,
): boolean {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const candidate = event as {
    sender?: unknown;
    senderFrame?: { url?: unknown } | null;
  };
  return candidate.sender !== undefined
    && trustedSenders.has(candidate.sender)
    && candidate.senderFrame !== null
    && typeof candidate.senderFrame?.url === "string"
    && isAllowedRendererUrl(candidate.senderFrame.url, approvedUrl);
}

export function projectCommandError(
  error: unknown,
  context: Pick<CommandErrorDto, "runId" | "stepId"> = {},
): CommandErrorDto {
  const candidate = isRecord(error) ? error : {};
  const safe = isSafeBoundaryError(error);
  const code = safe && typeof candidate.code === "string" && isSafeErrorCode(candidate.code)
    ? candidate.code
    : "INTERNAL_ERROR";
  const runId = (safe ? stringValue(candidate.runId) : undefined) ?? context.runId;
  const stepId = (safe ? stringValue(candidate.stepId) : undefined) ?? context.stepId;

  return brandCommandError({
    title: titleFor(code),
    detail: publicDetailFor(code),
    code,
    ...(runId === undefined ? {} : { runId }),
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function requestFor<Command extends Exclude<DbRelayCommand,
  "list_connections" | "list_flows" | "list_run_history">>(
  command: Command,
  request: unknown,
): CommandRequestMap[Command] {
  if (!isRecord(request)
    || !hasOnlyKeys(request, ["request"])
    || !isRecord(request.request)
    || !isValidRequestBody(command, request.request)) {
    throw serviceError("INVALID_REQUEST", "request payload is invalid");
  }
  return request as CommandRequestMap[Command];
}

function isValidRequestBody(command: DbRelayCommand, body: Record<string, unknown>): boolean {
  switch (command) {
    case "save_connection":
      return hasOnlyKeys(body, [
        "id", "displayName", "kind", "host", "port", "sid", "username", "secret",
      ])
        && isConnectionBody(body)
        && typeof body.secret === "string";
    case "update_connection":
      return hasOnlyKeys(body, [
        "id", "displayName", "kind", "host", "port", "sid", "username", "enabled",
        "replacementSecret",
      ])
        && isConnectionBody(body)
        && typeof body.enabled === "boolean"
        && (body.replacementSecret === undefined || typeof body.replacementSecret === "string");
    case "disable_connection":
    case "delete_connection":
    case "test_connection":
      return hasOnlyKeys(body, ["connectionId"])
        && typeof body.connectionId === "string";
    case "set_connection_enabled":
      return hasOnlyKeys(body, ["connectionId", "enabled"])
        && typeof body.connectionId === "string"
        && typeof body.enabled === "boolean";
    case "save_flow":
      return isFlowBody(body);
    case "duplicate_flow":
      return hasOnlyKeys(body, ["flowId", "duplicateId"])
        && typeof body.flowId === "string"
        && typeof body.duplicateId === "string";
    case "start_run":
      return hasOnlyKeys(body, ["flowId"])
        && typeof body.flowId === "string";
    case "recover_run":
      return isRecoveryBody(body);
    case "list_connections":
    case "list_flows":
    case "list_run_history":
      return false;
  }
}

function isConnectionBody(body: Record<string, unknown>): boolean {
  return typeof body.id === "string"
    && typeof body.displayName === "string"
    && body.kind === "oracle"
    && typeof body.host === "string"
    && Number.isInteger(body.port)
    && typeof body.sid === "string"
    && typeof body.username === "string";
}

function isFlowBody(body: Record<string, unknown>): boolean {
  return hasOnlyKeys(body, [
    "id", "name", "sourceConnectionId", "targetConnectionId", "querySteps",
    "transactionPolicy", "version",
  ])
    && typeof body.id === "string"
    && typeof body.name === "string"
    && typeof body.sourceConnectionId === "string"
    && typeof body.targetConnectionId === "string"
    && Array.isArray(body.querySteps)
    && body.querySteps.every(isQueryStepBody)
    && (body.transactionPolicy === "all_or_nothing"
      || body.transactionPolicy === "commit_successes")
    && Number.isInteger(body.version)
    && (body.version as number) >= 0;
}

function isQueryStepBody(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "selectSql", "upsertSql", "operation"])
    && typeof value.id === "string"
    && typeof value.selectSql === "string"
    && typeof value.upsertSql === "string"
    && (value.operation === undefined
      || value.operation === "insert"
      || value.operation === "update");
}

function isRecoveryBody(body: Record<string, unknown>): boolean {
  if (body.type === "edit_and_retry") {
    return hasOnlyKeys(body, ["type", "run_id", "step_id", "select_sql", "upsert_sql"])
      && typeof body.run_id === "string"
      && typeof body.step_id === "string"
      && typeof body.select_sql === "string"
      && typeof body.upsert_sql === "string";
  }
  if (body.type === "skip_and_continue" || body.type === "stop") {
    return hasOnlyKeys(body, ["type", "run_id", "step_id"])
      && typeof body.run_id === "string"
      && typeof body.step_id === "string";
  }
  return false;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function newConnectionProfile(
  input: CommandRequestMap["save_connection"]["request"],
): ConnectionProfile {
  return {
    id: input.id,
    displayName: input.displayName,
    kind: input.kind,
    host: input.host,
    port: input.port,
    sid: input.sid,
    username: input.username,
    credentialRef: input.id,
    credentialStorage: "plaintext",
    plaintextPassword: input.secret,
    enabled: true,
    sourceReadOnly: false,
  };
}

function updatedConnectionProfile(
  input: CommandRequestMap["update_connection"]["request"],
): ConnectionProfile {
  return {
    id: input.id,
    displayName: input.displayName,
    kind: input.kind,
    host: input.host,
    port: input.port,
    sid: input.sid,
    username: input.username,
    credentialRef: input.id,
    credentialStorage: "plaintext",
    plaintextPassword: input.replacementSecret,
    enabled: input.enabled,
    sourceReadOnly: false,
  };
}

function findConnection(
  connections: Awaited<ReturnType<SettingsBoundary["listConnectionDtos"]>>,
  connectionId: string,
): ConnectionDto {
  const connection = connections.find((candidate) => candidate.id === connectionId);
  if (connection === undefined) {
    throw serviceError("CONNECTION_NOT_FOUND", "connection not found");
  }
  return projectConnection(connection);
}

function projectConnection(connection: Awaited<ReturnType<
  SettingsBoundary["listConnectionDtos"]
>>[number]): ConnectionDto {
  return {
    id: connection.id,
    displayName: connection.displayName,
    kind: connection.kind,
    host: connection.host,
    port: connection.port,
    sid: connection.sid,
    username: connection.username,
    passwordMask: connection.passwordMask,
    enabled: connection.enabled,
  };
}

function projectFlow(flow: Flow): FlowDto {
  return {
    id: flow.id,
    name: flow.name,
    sourceConnectionId: flow.sourceConnectionId,
    targetConnectionId: flow.targetConnectionId,
    querySteps: flow.querySteps.map((step) => ({
      id: step.id,
      selectSql: step.selectSql,
      upsertSql: step.upsertSql,
    })),
    transactionPolicy: flow.transactionPolicy,
    version: flow.version,
  };
}

function recoveryRequest(request: RecoverRunRequestDto): RecoveryRequest {
  if (request.type === "edit_and_retry") {
    return {
      type: request.type,
      runId: request.run_id,
      stepId: request.step_id,
      selectSql: request.select_sql,
      upsertSql: request.upsert_sql,
    };
  }
  return {
    type: request.type,
    runId: request.run_id,
    stepId: request.step_id,
  };
}

function projectRun(run: RunDto): RunDto {
  return {
    runId: run.runId,
    policy: run.policy,
    status: projectStatus(run.status),
    steps: run.steps.map(projectStep),
    events: run.events.map(projectEvent),
  };
}

function projectHistoryRun(run: HistoryRunDto): HistoryRunDto {
  return {
    ...projectRun(run),
    flowId: run.flowId,
    flowVersion: run.flowVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

function projectStatus(status: RunStatus): RunStatusDto {
  if (typeof status === "string") {
    return status;
  }
  if ("running" in status) {
    return { running: { step: status.running.step } };
  }
  if ("awaiting_recovery" in status) {
    return { awaiting_recovery: { failed_step: status.awaiting_recovery.failed_step } };
  }
  if ("recovery_pending" in status) {
    return {
      recovery_pending: {
        failed_step: status.recovery_pending.failed_step,
        action: status.recovery_pending.action,
      },
    };
  }
  if ("commit_pending" in status) {
    return { commit_pending: { step: status.commit_pending.step } };
  }
  if ("in_doubt" in status) {
    return {
      in_doubt: {
        step: status.in_doubt.step,
        reason: projectRunError(status.in_doubt.reason),
      },
    };
  }
  const exhaustiveStatus: never = status;
  return exhaustiveStatus;
}

function projectStep(step: StepStatus): StepStatusDto {
  if (typeof step === "string") {
    return step;
  }
  return { succeeded: { affected_rows: step.succeeded.affected_rows } };
}

function projectEvent(event: RunEvent): RunEventDto {
  switch (event.type) {
    case "step_succeeded":
      return { type: event.type, step: event.step, affected_rows: event.affected_rows };
    case "step_failed":
      return { type: event.type, step: event.step, error: projectRunError(event.error) };
    case "transaction_failed":
      return { type: event.type, error: projectRunError(event.error) };
    case "recovery_applied":
      return { type: event.type, step: event.step, action: event.action };
  }
}

function projectRunError(error: RunErrorData): RunErrorDto {
  if (error.type === "connector") {
    return {
      type: error.type,
      detail: {
        code: error.detail.code,
        message: "Database operation failed; inspect the database server audit log",
        retryable: error.detail.retryable,
      },
    };
  }
  switch (error.type) {
    case "invalid_transition":
      return {
        type: error.type,
        detail: {
          status: projectStatus(error.detail.status),
          action: error.detail.action,
        },
      };
    case "invalid_step":
      return {
        type: error.type,
        detail: {
          expected: error.detail.expected,
          received: error.detail.received,
        },
      };
    case "step_out_of_bounds":
      return {
        type: error.type,
        detail: {
          step: error.detail.step,
          step_count: error.detail.step_count,
        },
      };
  }
}

function commandNotAllowed(): CommandErrorDto {
  return {
    title: "Request could not be completed",
    detail: "The requested command is not available.",
    code: "COMMAND_NOT_ALLOWED",
  };
}

function publicDetailFor(code: string): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "request payload is invalid";
    case "CONNECTION_NOT_FOUND":
      return "connection not found";
    case "CONNECTION_DISABLED":
      return "connection is disabled";
    case "CONNECTION_REFERENCED":
      return "The connection is used by a flow and cannot be deleted.";
    case "CREDENTIAL_NOT_FOUND":
    case "CREDENTIAL_STORE":
      return "credentials are unavailable";
    case "FLOW_NOT_FOUND":
      return "flow not found";
    case "RUN_NOT_FOUND":
      return "run not found";
    case "RECOVERY_NOT_AVAILABLE":
      return "recovery is unavailable";
    case "RECOVERY_CONFIG_MISMATCH":
      return "run configuration changed";
    case "RUN_FAILED":
    case "CONNECTOR_ERROR":
      return "Database operation failed; inspect the database server audit log";
    default:
      return /^ORA-\d{5}$/u.test(code)
        ? "Database operation failed; inspect the database server audit log"
        : "The request could not be completed.";
  }
}

function serviceError(code: string, message: string): Error & { code: string } {
  return new IpcBoundaryError(code, message);
}

function titleFor(code: string): string {
  switch (code) {
    case "CONNECTION_NOT_FOUND":
      return "Connection not found";
    case "CONNECTION_DISABLED":
      return "Connection is disabled";
    case "CONNECTION_REFERENCED":
      return "Connection is in use";
    case "CREDENTIAL_NOT_FOUND":
    case "CREDENTIAL_STORE":
      return "Credentials unavailable";
    case "FLOW_NOT_FOUND":
      return "Flow not found";
    case "RUN_NOT_FOUND":
      return "Run not found";
    case "RECOVERY_NOT_AVAILABLE":
      return "Recovery is unavailable";
    case "RECOVERY_CONFIG_MISMATCH":
      return "Run configuration changed";
    default:
      return "Request could not be completed";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSafeErrorCode(code: string): boolean {
  return /^(?:[A-Z][A-Z0-9_]{0,63}|ORA-\d{5})$/u.test(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeBoundaryError(
  error: unknown,
): boolean {
  return error instanceof IpcBoundaryError
    || error instanceof SettingsServiceError
    || error instanceof FlowServiceError
    || error instanceof MigrationRunnerError
    || error instanceof RepositoryError
    || error instanceof ConnectorError
    || isProjectedCommandError(error);
}

class IpcBoundaryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "IpcBoundaryError";
  }
}

function brandCommandError(error: CommandErrorDto): CommandErrorDto {
  Object.defineProperty(error, projectedCommandError, { value: true });
  return error;
}

function isProjectedCommandError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { [projectedCommandError]?: unknown })[projectedCommandError] === true;
}

export function isAllowedRendererUrl(candidateUrl: string, approvedUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const approved = new URL(approvedUrl);
    return approved.protocol === "file:"
      ? candidate.protocol === approved.protocol
        && candidate.host === approved.host
        && candidate.pathname === approved.pathname
      : candidate.origin === approved.origin;
  } catch {
    return false;
  }
}
