import { randomUUID } from "node:crypto";

import type {
  DatabaseConnectorFactory,
  DatabaseSession,
} from "../connectors/databaseConnector";
import { extractNamedBinds, mapRow } from "../domain/mapping";
import type {
  ConnectionProfile,
  Flow,
  NamedRow,
  QueryStep,
  RowSet,
  RunEvent,
  RunStatus,
  StepStatus,
  TransactionPolicy,
} from "../domain/models";
import { RunError, RunState } from "../domain/runState";
import { validateSourceStatement, validateTargetStatement } from "../domain/sqlValidation";
import type { FlowRepository, HistoryRepository, RunBinding } from "./ports";

export interface CredentialResolver {
  resolve(account: string): Promise<string>;
  store?(account: string, secret: string): Promise<void>;
}

export interface RunDto {
  runId: string;
  policy: TransactionPolicy;
  status: RunStatus;
  steps: StepStatus[];
  events: RunEvent[];
}

export type RecoveryRequest =
  | {
    type: "edit_and_retry";
    runId: string;
    stepId: string;
    selectSql: string;
    upsertSql: string;
  }
  | { type: "skip_and_continue"; runId: string; stepId: string }
  | { type: "stop"; runId: string; stepId: string };

export class MigrationRunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MigrationRunnerError";
  }
}

export class MigrationRunner {
  constructor(
    private readonly connector: DatabaseConnectorFactory,
    private readonly flows: FlowRepository,
    private readonly history: HistoryRepository,
    private readonly credentials?: CredentialResolver,
  ) {}

  async previewFlowStep(input: {
    sourceConnectionId: string;
    selectSql: string;
  }): Promise<{ columns: string[]; rows: NamedRow[] }> {
    const sourceProfile = this.loadRunnableProfile(input.sourceConnectionId, "source");
    if (sourceProfile.kind !== this.connector.kind) {
      throw new MigrationRunnerError("CONNECTOR_KIND_MISMATCH", "connector kind does not match");
    }
    try {
      validateSourceStatement(input.selectSql);
    } catch {
      throw new MigrationRunnerError(
        "STATEMENT_INVALID",
        "source SQL must follow the migration statement policy",
      );
    }

    let source: DatabaseSession | undefined;
    try {
      const sourceSecret = await this.resolveCredential(sourceProfile);
      source = await this.connector.open(sourceProfile, sourceSecret);
      const rowSet = await source.query(input.selectSql);
      return { columns: rowSet.columns, rows: rowSet.rows };
    } catch (error) {
      throw asMigrationRunnerError(error);
    } finally {
      await closeSessions(source);
    }
  }

  async runFlowStep(input: {
    sourceConnectionId: string;
    targetConnectionId: string;
    selectSql: string;
    upsertSql: string;
  }): Promise<{ affectedRows: number }> {
    if (input.sourceConnectionId === input.targetConnectionId) {
      throw new MigrationRunnerError(
        "CONNECTIONS_NOT_DISTINCT",
        "source and target connections must be different",
      );
    }
    const sourceProfile = this.loadRunnableProfile(input.sourceConnectionId, "source");
    const targetProfile = this.loadRunnableProfile(input.targetConnectionId, "target");
    if (sourceProfile.kind !== this.connector.kind || targetProfile.kind !== this.connector.kind) {
      throw new MigrationRunnerError("CONNECTOR_KIND_MISMATCH", "connector kind does not match");
    }

    const step: QueryStep = {
      id: "current-flow-step",
      selectSql: input.selectSql,
      upsertSql: input.upsertSql,
    };
    let source: DatabaseSession | undefined;
    let target: DatabaseSession | undefined;
    let began = false;
    try {
      validateStepPolicy(targetProfile, step);
      const sourceSecret = await this.resolveCredential(sourceProfile);
      const targetSecret = await this.resolveCredential(targetProfile);
      source = await this.connector.open(sourceProfile, sourceSecret);
      target = await this.connector.open(targetProfile, targetSecret);
      const batch = await prepareStepBatch(source, step);
      validateTargetBatch(batch);
      await target.begin();
      began = true;
      const affectedRows = await target.executeNamed(step.upsertSql, batch);
      await target.commit();
      return { affectedRows };
    } catch (error) {
      if (began && target !== undefined) {
        const startedTarget = target;
        await Promise.resolve().then(() => startedTarget.rollback()).catch(() => undefined);
      }
      throw asMigrationRunnerError(error);
    } finally {
      await closeSessions(target, source);
    }
  }

  async startRun(flowId: string): Promise<RunDto> {
    const flow = this.flows.loadFlow(flowId);
    if (flow === undefined) {
      throw new MigrationRunnerError("FLOW_NOT_FOUND", "flow not found");
    }
    const runId = randomUUID();

    if (flow.sourceConnectionId === flow.targetConnectionId) {
      return this.createPreflightFailure(
        runId,
        flow,
        0,
        RunError.connector(
          "CONNECTIONS_NOT_DISTINCT",
          "source and target connections must be different",
        ),
      );
    }

    let sourceProfile: ConnectionProfile | undefined;
    let targetProfile: ConnectionProfile | undefined;
    try {
      sourceProfile = this.flows.loadRunnableConnection(flow.sourceConnectionId);
    } catch (error) {
      return this.createPreflightFailure(runId, flow, 0, portRunError(error));
    }
    if (sourceProfile === undefined) {
      return this.createPreflightFailure(
        runId,
        flow,
        0,
        RunError.connector("CONNECTION_NOT_FOUND", "source connection was not found"),
      );
    }
    try {
      targetProfile = this.flows.loadRunnableConnection(flow.targetConnectionId);
    } catch (error) {
      return this.createPreflightFailure(runId, flow, 0, portRunError(error));
    }
    if (targetProfile === undefined) {
      return this.createPreflightFailure(
        runId,
        flow,
        0,
        RunError.connector("CONNECTION_NOT_FOUND", "target connection was not found"),
      );
    }
    if (sourceProfile.kind !== this.connector.kind || targetProfile.kind !== this.connector.kind) {
      return this.createPreflightFailure(
        runId,
        flow,
        0,
        RunError.connector("CONNECTOR_KIND_MISMATCH", "connector kind does not match"),
      );
    }
    for (let index = 0; index < flow.querySteps.length; index += 1) {
      try {
        validateStepPolicy(targetProfile, flow.querySteps[index]);
      } catch (error) {
        return this.createPreflightFailure(runId, flow, index, asRunError(error));
      }
    }

    let sourceSecret: string;
    let targetSecret: string;
    try {
      sourceSecret = await this.resolveCredential(sourceProfile);
      targetSecret = await this.resolveCredential(targetProfile);
    } catch (error) {
      return this.createPreflightFailure(runId, flow, 0, portRunError(error));
    }

    const binding = { flow, sourceProfile, targetProfile };
    const initialState = RunState.running(flow.transactionPolicy, flow.querySteps.length);
    this.history.createBoundRun(runId, initialState, binding);

    let source: DatabaseSession | undefined;
    let target: DatabaseSession | undefined;
    try {
      try {
        source = await this.connector.open(sourceProfile, sourceSecret);
      } catch (error) {
        return this.persistExistingPreflightFailure(runId, initialState, 0, portRunError(error));
      }
      try {
        target = await this.connector.open(targetProfile, targetSecret);
      } catch (error) {
        return this.persistExistingPreflightFailure(runId, initialState, 0, portRunError(error));
      }

      const batches: NamedRow[][] = [];
      for (let index = 0; index < flow.querySteps.length; index += 1) {
        try {
          batches.push(await preflightStep(source, targetProfile, flow.querySteps[index]));
        } catch (error) {
          return this.persistExistingPreflightFailure(runId, initialState, index, asRunError(error));
        }
      }
      if (flow.transactionPolicy === "commit_successes") {
        return await this.executeCommittedSteps(
          runId,
          binding,
          initialState,
          source,
          target,
          batches,
        );
      }
      return await this.executeAllOrNothing(runId, flow, initialState, target, batches);
    } finally {
      await closeSessions(target, source);
    }
  }

  async recoverRun(request: RecoveryRequest): Promise<RunDto> {
    const state = this.history.loadRun(request.runId);
    if (state === undefined) {
      throw new MigrationRunnerError("RUN_NOT_FOUND", "run was not found");
    }
    const status = state.status();
    if (typeof status !== "object" || !("awaiting_recovery" in status)) {
      throw new MigrationRunnerError(
        "RECOVERY_NOT_AVAILABLE",
        "run is not awaiting recovery",
      );
    }
    const failedStep = status.awaiting_recovery.failed_step;
    const binding = this.history.loadRunBinding(request.runId);
    if (binding === undefined) {
      throw new MigrationRunnerError(
        "RECOVERY_CONFIG_MISMATCH",
        "run configuration is unavailable for recovery",
      );
    }
    this.ensureRecoveryBinding(binding);
    if (binding.flow.querySteps[failedStep]?.id !== request.stepId) {
      throw new MigrationRunnerError(
        "RECOVERY_STEP_MISMATCH",
        "recovery request does not target the failed step",
      );
    }

    const pausedState = cloneState(state);
    if (request.type === "stop") {
      state.applyRecovery("stop");
      this.applyBoundRecovery(
        request.runId,
        state,
        pausedState,
        binding,
        binding,
      );
      return snapshot(request.runId, state);
    }
    if (request.type === "skip_and_continue") {
      return this.skipAndContinue(request.runId, state, pausedState, binding);
    }
    return this.editAndRetry(request, state, pausedState, binding, failedStep);
  }

  private async skipAndContinue(
    runId: string,
    state: RunState,
    pausedState: RunState,
    binding: RunBinding,
  ): Promise<RunDto> {
    state.reserveRecovery("skip_and_continue");
    this.applyBoundRecovery(runId, state, pausedState, binding, binding);
    const reservedState = cloneState(state);
    state.applyReservedRecovery();
    if (state.status() === "completed") {
      this.applyBoundRecovery(runId, state, reservedState, binding, binding);
      return snapshot(runId, state);
    }
    if (!isRunning(state.status())) {
      throw new MigrationRunnerError("RUN_STATE_INVALID", "recovery could not resume the run");
    }

    const sessions = await this.tryOpenBoundSessions(binding);
    if (sessions === undefined) {
      return this.returnReservedRecovery(runId, reservedState, binding);
    }
    try {
      return await this.executeCommittedSteps(
        runId,
        binding,
        state,
        sessions.source,
        sessions.target,
      );
    } finally {
      await closeSessions(sessions.target, sessions.source);
    }
  }

  private async editAndRetry(
    request: Extract<RecoveryRequest, { type: "edit_and_retry" }>,
    state: RunState,
    pausedState: RunState,
    binding: RunBinding,
    failedStep: number,
  ): Promise<RunDto> {
    if (!Number.isSafeInteger(binding.flow.version + 1)) {
      throw new MigrationRunnerError("FLOW_VERSION_INVALID", "flow version cannot be advanced");
    }
    const candidateBinding = structuredClone(binding);
    const candidateStep = candidateBinding.flow.querySteps[failedStep];
    if (candidateStep === undefined) {
      throw new MigrationRunnerError("RECOVERY_STEP_MISMATCH", "failed step was not found");
    }
    candidateStep.selectSql = request.selectSql;
    candidateStep.upsertSql = request.upsertSql;
    candidateBinding.flow.version += 1;

    state.reserveRecovery("edit_and_retry");
    this.applyBoundRecovery(request.runId, state, pausedState, binding, binding);
    const reservedState = cloneState(state);
    const sessions = await this.tryOpenBoundSessions(candidateBinding);
    if (sessions === undefined) {
      return this.returnReservedRecovery(request.runId, reservedState, binding);
    }
    try {
      try {
        await preflightStep(
          sessions.source,
          candidateBinding.targetProfile,
          candidateStep,
        );
      } catch {
        return this.returnReservedRecovery(request.runId, reservedState, binding);
      }
      this.applyBoundRecovery(
        request.runId,
        state,
        reservedState,
        binding,
        candidateBinding,
        candidateBinding.flow,
      );
      state.applyReservedRecovery();
      return await this.executeCommittedSteps(
        request.runId,
        candidateBinding,
        state,
        sessions.source,
        sessions.target,
      );
    } finally {
      await closeSessions(sessions.target, sessions.source);
    }
  }

  private async executeAllOrNothing(
    runId: string,
    flow: Flow,
    initialState: RunState,
    target: DatabaseSession,
    batches: readonly NamedRow[][],
  ): Promise<RunDto> {
    const state = initialState;
    try {
      await target.begin();
    } catch (error) {
      return this.persistExistingPreflightFailure(runId, state, 0, portRunError(error));
    }
    for (let index = 0; index < flow.querySteps.length; index += 1) {
      try {
        const affectedRows = await target.executeNamed(flow.querySteps[index].upsertSql, batches[index]);
        state.recordStepSuccess(index, affectedRows);
      } catch (error) {
        state.recordStepFailure(index, executionRunError(error));
        try {
          await target.rollback();
        } catch (rollbackError) {
          state.markInDoubt(index, portRunError(rollbackError));
        }
        this.history.appendRun(runId, state);
        return snapshot(runId, state);
      }
    }
    if (flow.querySteps.length > 0) {
      state.markCommitPending(flow.querySteps.length - 1);
      this.history.appendRun(runId, state);
    }
    try {
      await target.commit();
    } catch (error) {
      const step = Math.max(0, flow.querySteps.length - 1);
      state.markInDoubt(step, portRunError(error));
      try {
        await target.rollback();
      } catch (rollbackError) {
        state.markInDoubt(step, portRunError(rollbackError));
      }
      this.history.appendRun(runId, state);
      return snapshot(runId, state);
    }
    if (flow.querySteps.length > 0) {
      state.confirmPendingCommit();
    }
    this.history.appendRun(runId, state);
    return snapshot(runId, state);
  }

  private async executeCommittedSteps(
    runId: string,
    binding: RunBinding,
    state: RunState,
    source: DatabaseSession,
    target: DatabaseSession,
    preparedBatches?: readonly NamedRow[][],
  ): Promise<RunDto> {
    const currentStatus = state.status();
    if (currentStatus === "completed") {
      this.history.appendBoundRun(runId, state, binding);
      return snapshot(runId, state);
    }
    if (!isRunning(currentStatus)) {
      throw new MigrationRunnerError(
        "RUN_STATE_INVALID",
        "committed-step execution requires a running state",
      );
    }

    for (let index = currentStatus.running.step; index < binding.flow.querySteps.length; index += 1) {
      const step = binding.flow.querySteps[index];
      let batch: NamedRow[];
      try {
        validateStepPolicy(binding.targetProfile, step);
        batch = preparedBatches?.[index]
          ?? await prepareStepBatch(source, step);
        validateTargetBatch(batch);
      } catch (error) {
        state.recordStepFailure(index, asRunError(error));
        this.history.appendBoundRun(runId, state, binding);
        return snapshot(runId, state);
      }

      try {
        await target.begin();
      } catch (error) {
        return this.rollbackCommittedFailure(
          runId,
          binding,
          state,
          target,
          index,
          portRunError(error),
        );
      }
      let affectedRows: number;
      try {
        affectedRows = await target.executeNamed(step.upsertSql, batch);
      } catch (error) {
        return this.rollbackCommittedFailure(
          runId,
          binding,
          state,
          target,
          index,
          executionRunError(error),
        );
      }
      state.markCommitPending(index);
      this.history.appendBoundRun(runId, state, binding);
      try {
        await target.commit();
      } catch (error) {
        return this.rollbackCommittedFailure(
          runId,
          binding,
          state,
          target,
          index,
          portRunError(error),
        );
      }
      state.recordStepSuccess(index, affectedRows);
      this.history.appendBoundRun(runId, state, binding);
    }
    return snapshot(runId, state);
  }

  private async rollbackCommittedFailure(
    runId: string,
    binding: RunBinding,
    state: RunState,
    target: DatabaseSession,
    step: number,
    error: RunError,
  ): Promise<RunDto> {
    const status = state.status();
    if (typeof status === "object" && "commit_pending" in status) {
      state.markInDoubt(step, error);
    } else {
      state.recordStepFailure(step, error);
    }
    try {
      await target.rollback();
    } catch (rollbackError) {
      state.markInDoubt(step, portRunError(rollbackError));
    }
    this.history.appendBoundRun(runId, state, binding);
    return snapshot(runId, state);
  }

  private createPreflightFailure(
    runId: string,
    flow: Flow,
    stepIndex: number,
    error: RunError,
  ): RunDto {
    const state = failedState(flow.transactionPolicy, flow.querySteps.length, stepIndex, error);
    this.history.createRunForFlow(runId, state, flow);
    return snapshot(runId, state);
  }

  private persistExistingPreflightFailure(
    runId: string,
    initialState: RunState,
    stepIndex: number,
    error: RunError,
  ): RunDto {
    const state = failedState(initialState.policy(), initialState.steps().length, stepIndex, error);
    this.history.appendRun(runId, state);
    return snapshot(runId, state);
  }

  private ensureRecoveryBinding(binding: RunBinding): void {
    const flow = this.flows.loadFlow(binding.flow.id);
    const source = this.flows.loadConnection(binding.sourceProfile.id);
    const target = this.flows.loadConnection(binding.targetProfile.id);
    if (!sameJson(flow, binding.flow)
      || !sameJson(source, binding.sourceProfile)
      || !sameJson(target, binding.targetProfile)) {
      throw new MigrationRunnerError(
        "RECOVERY_CONFIG_MISMATCH",
        "flow or connection configuration changed after the run paused",
      );
    }
  }

  private applyBoundRecovery(
    runId: string,
    state: RunState,
    expectedState: RunState,
    expectedBinding: RunBinding,
    persistedBinding: RunBinding,
    updatedFlow?: Flow,
  ): void {
    const result = this.history.applyBoundRecovery(
      runId,
      state,
      expectedState,
      expectedBinding,
      persistedBinding,
      updatedFlow,
    );
    if (result === "configuration_changed") {
      throw new MigrationRunnerError(
        "RECOVERY_CONFIG_MISMATCH",
        "flow or connection configuration changed after the run paused",
      );
    }
    if (result === "recovery_no_longer_available") {
      throw new MigrationRunnerError(
        "RECOVERY_NOT_AVAILABLE",
        "run is no longer awaiting recovery",
      );
    }
  }

  private returnReservedRecovery(
    runId: string,
    expectedState: RunState,
    binding: RunBinding,
  ): RunDto {
    const state = cloneState(expectedState);
    state.returnReservedRecoveryToAwaiting();
    this.applyBoundRecovery(runId, state, expectedState, binding, binding);
    return snapshot(runId, state);
  }

  private async tryOpenBoundSessions(
    binding: RunBinding,
  ): Promise<{ source: DatabaseSession; target: DatabaseSession } | undefined> {
    if (binding.sourceProfile.id === binding.targetProfile.id
      || binding.sourceProfile.kind !== this.connector.kind
      || binding.targetProfile.kind !== this.connector.kind) {
      return undefined;
    }
    let source: DatabaseSession | undefined;
    try {
      const sourceSecret = await this.resolveCredential(binding.sourceProfile);
      const targetSecret = await this.resolveCredential(binding.targetProfile);
      source = await this.connector.open(binding.sourceProfile, sourceSecret);
      const target = await this.connector.open(binding.targetProfile, targetSecret);
      return { source, target };
    } catch {
      await closeSessions(source);
      return undefined;
    }
  }

  private async resolveCredential(profile: ConnectionProfile): Promise<string> {
    if (profile.credentialStorage === "plaintext") {
      if (profile.plaintextPassword === undefined || profile.plaintextPassword === null) {
        throw new MigrationRunnerError("CREDENTIAL_NOT_FOUND", "plaintext password was not found");
      }
      return profile.plaintextPassword;
    }
    if (this.credentials === undefined) {
      throw new MigrationRunnerError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }
    try {
      return await this.credentials.resolve(profile.credentialRef);
    } catch (error) {
      if (errorCode(error) !== "CREDENTIAL_NOT_FOUND" || profile.credentialRef === profile.id) {
        throw error;
      }
      const legacy = await this.credentials.resolve(profile.id);
      await this.credentials.store?.(profile.credentialRef, legacy);
      return legacy;
    }
  }

  private loadRunnableProfile(connectionId: string, role: "source" | "target"): ConnectionProfile {
    let profile: ConnectionProfile | undefined;
    try {
      profile = this.flows.loadRunnableConnection(connectionId);
    } catch (error) {
      throw asMigrationRunnerError(error);
    }
    if (profile === undefined) {
      throw new MigrationRunnerError(
        "CONNECTION_NOT_FOUND",
        `${role} connection was not found`,
      );
    }
    return profile;
  }
}

async function preflightStep(
  source: DatabaseSession,
  targetProfile: ConnectionProfile,
  step: QueryStep,
): Promise<NamedRow[]> {
  validateStepPolicy(targetProfile, step);
  const batch = await prepareStepBatch(source, step);
  validateTargetBatch(batch);
  return batch;
}

async function prepareStepBatch(source: DatabaseSession, step: QueryStep): Promise<NamedRow[]> {
  const rows = await source.query(step.selectSql).catch((error: unknown) => {
    throw sourceRunError(error);
  });
  let binds: string[];
  try {
    binds = extractNamedBinds(step.upsertSql);
  } catch {
    throw RunError.connector(
      "MAPPING_INVALID",
      "target bind syntax could not be validated",
    );
  }
  if (rows.unsupportedBindColumns.some((column) =>
    binds.some((bind) => bind.toUpperCase() === column.toUpperCase()))) {
    throw RunError.connector(
      "BIND_TYPE_UNSUPPORTED",
      "source column type is unsupported by the target bind capability",
    );
  }
  try {
    validateColumns(rows, binds);
    return rows.rows.map((row) => mapRow(row, binds));
  } catch {
    throw RunError.connector(
      "MAPPING_INVALID",
      "source columns do not satisfy target bind parameters",
    );
  }
}

function validateStepPolicy(targetProfile: ConnectionProfile, step: QueryStep): void {
  try {
    validateSourceStatement(step.selectSql);
    validateTargetStatement(targetProfile.kind, step.upsertSql);
  } catch {
    throw RunError.connector(
      "STATEMENT_INVALID",
      "source and target SQL must follow the migration statement policy",
    );
  }
}

function validateColumns(rows: RowSet, binds: readonly string[]): void {
  const metadata = Object.create(null) as Record<string, null>;
  for (const column of rows.columns) {
    if (Object.keys(metadata).some((existing) => existing.toUpperCase() === column.toUpperCase())) {
      throw new Error("duplicate column");
    }
    metadata[column] = null;
  }
  mapRow(metadata, binds);
}

function validateTargetBatch(batch: readonly NamedRow[]): void {
  for (const value of batch.flatMap((row) => Object.values(row))) {
    if (value instanceof Date
      || (isRecord(value)
        && "tzHourOffset" in value
        && "tzMinuteOffset" in value
        && (value.tzHourOffset !== 0 || value.tzMinuteOffset !== 0))) {
      throw RunError.connector(
        "BIND_TYPE_UNSUPPORTED",
        "source timestamp values are not supported by the target bind capability",
      );
    }
  }
}

function failedState(
  policy: TransactionPolicy,
  stepCount: number,
  stepIndex: number,
  error: RunError,
): RunState {
  const steps = Array.from({ length: stepCount }, () => "not_run" as StepStatus);
  const events: RunEvent[] = [];
  if (steps[stepIndex] !== undefined) {
    steps[stepIndex] = "failed";
    events.push({ type: "step_failed", step: stepIndex, error: error.toJSON() });
  }
  return RunState.fromHistory(policy, "failed", steps, events);
}

function snapshot(runId: string, state: RunState): RunDto {
  return {
    runId,
    policy: state.policy(),
    status: state.status(),
    steps: state.steps().map((step) => step.status),
    events: [...state.events()],
  };
}

function cloneState(state: RunState): RunState {
  return RunState.fromJSON(state.toJSON());
}

function executionRunError(error: unknown): RunError {
  const detail = errorDetail(error);
  return RunError.connectorWithRetryable(
    detail.code,
    "target execution failed; inspect the database server audit log",
    detail.retryable,
  );
}

function sourceRunError(error: unknown): RunError {
  const detail = errorDetail(error);
  return RunError.connectorWithRetryable(
    detail.code,
    "source query failed; inspect the database server audit log",
    detail.retryable,
  );
}

function asRunError(error: unknown): RunError {
  return error instanceof RunError ? error : portRunError(error);
}

function portRunError(error: unknown): RunError {
  const detail = errorDetail(error);
  return RunError.connectorWithRetryable(detail.code, detail.message, detail.retryable);
}

function asMigrationRunnerError(error: unknown): MigrationRunnerError {
  if (error instanceof MigrationRunnerError) {
    return error;
  }
  if (error instanceof RunError) {
    const runError = error.toJSON();
    if (runError.type === "connector") {
      return new MigrationRunnerError(
        runError.detail.code,
        "database operation failed; inspect the database server audit log",
        error.retryable(),
      );
    }
  }
  const detail = errorDetail(error);
  return new MigrationRunnerError(
    detail.code,
    "database operation failed; inspect the database server audit log",
    detail.retryable,
  );
}

function errorDetail(error: unknown): { code: string; message: string; retryable: boolean } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "CONNECTOR_ERROR",
      message: typeof candidate.message === "string" ? candidate.message : "connector operation failed",
      retryable: candidate.retryable === true,
    };
  }
  return { code: "CONNECTOR_ERROR", message: "connector operation failed", retryable: false };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function closeSessions(...sessions: Array<DatabaseSession | undefined>): Promise<void> {
  await Promise.allSettled(sessions.filter((session): session is DatabaseSession => session !== undefined)
    .map((session) => Promise.resolve().then(() => session.close())));
}

function isRunning(status: RunStatus): status is { running: { step: number } } {
  return typeof status === "object" && "running" in status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
