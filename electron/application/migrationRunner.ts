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
import { EditablePreviewCache } from "./editablePreviewCache";
import { StepRestoreCache, type RestoreAction } from "./stepRestoreCache";
import { parseRestorableDml, type TargetBindColumn } from "../domain/restorableDml";
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
  stepTitles: string[];
}

export type RunProgress = {
  runId: string;
  step: number;
  processedRows: number;
  totalRows: number;
  completedBatches: number;
  totalBatches: number;
};

export type RunProgressReporter = (progress: RunProgress) => void;

const RUN_BATCH_SIZE = 1_000;

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
    private readonly editablePreviews = new EditablePreviewCache(),
    private readonly stepRestores = new StepRestoreCache(),
  ) {}

  async previewFlowStep(input: {
    sourceConnectionId: string;
    selectSql: string;
  }): Promise<{ previewId: string; columns: string[]; rows: NamedRow[] }> {
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
      return {
        previewId: this.editablePreviews.create(
          rowSet.columns,
          rowSet.rows,
          rowSet.unsupportedBindColumns,
        ),
        columns: rowSet.columns,
        rows: rowSet.rows,
      };
    } catch (error) {
      throw asMigrationRunnerError(error);
    } finally {
      await closeSessions(source);
    }
  }

  saveEditedPreview(input: {
    previewId: string;
    columns: string[];
    rows: NamedRow[];
  }): void {
    this.editablePreviews.save(input.previewId, input.columns, input.rows);
  }

  discardEditedPreview(previewId: string): void {
    this.editablePreviews.discard(previewId);
  }

  async runFlowStep(input: {
    sourceConnectionId: string;
    targetConnectionId: string;
    selectSql: string;
    upsertSql: string;
    previewId?: string;
    editorSessionId?: string;
    stepId?: string;
  }): Promise<{ affectedRows: number; restoreId?: string }> {
    const step: QueryStep = {
      id: "current-flow-step",
      selectSql: input.selectSql,
      upsertSql: input.upsertSql,
    };
    let source: DatabaseSession | undefined;
    let target: DatabaseSession | undefined;
    let began = false;
    try {
      const savedRows = input.previewId === undefined
        ? undefined
        : this.editablePreviews.consume(input.previewId);
      const sourceProfile = savedRows === undefined
        ? this.loadRunnableProfile(input.sourceConnectionId, "source")
        : undefined;
      const targetProfile = this.loadRunnableProfile(input.targetConnectionId, "target");
      if ((sourceProfile !== undefined && sourceProfile.kind !== this.connector.kind)
        || targetProfile.kind !== this.connector.kind) {
        throw new MigrationRunnerError("CONNECTOR_KIND_MISMATCH", "connector kind does not match");
      }
      validateStepPolicy(targetProfile, step);
      const targetSecret = await this.resolveCredential(targetProfile);
      if (sourceProfile !== undefined) {
        const sourceSecret = await this.resolveCredential(sourceProfile);
        source = await this.connector.open(sourceProfile, sourceSecret);
      }
      target = await this.connector.open(targetProfile, targetSecret);
      let batch = savedRows === undefined
        ? await prepareStepBatch(source!, step)
        : prepareRowSetBatch(savedRows, step);
      const plan = parseRestorableDml(step.upsertSql);
      if (savedRows !== undefined && plan !== undefined && target.describeTargetColumns !== undefined) {
        const columnKinds = await target.describeTargetColumns(
          plan.table,
          plan.bindColumns.map(({ column }) => column),
        );
        batch = coerceSavedPreviewBatch(batch, plan.bindColumns, columnKinds);
      }
      validateTargetBatch(batch);
      if (input.editorSessionId && input.stepId) this.stepRestores.discardStep(input.editorSessionId, input.stepId);
      const before = plan === undefined || plan.kind === "insert" || target.queryNamed === undefined
        ? undefined : await captureRestoreRows(target, plan.table, plan.keyTerms, plan.assignedColumns, batch);
      await target.begin();
      began = true;
      const insertResult = plan?.kind === "insert" && target.executeNamedReturningRowIds !== undefined
        ? await target.executeNamedReturningRowIds(sqlReturningRowId(step.upsertSql), batch)
        : undefined;
      const affectedRows = insertResult?.affectedRows ?? await target.executeNamed(step.upsertSql, batch);
      const after = plan === undefined || plan.kind === "insert" || target.queryNamed === undefined
        ? undefined : await captureRestoreRows(target, plan.table, plan.keyTerms, plan.assignedColumns, batch);
      await target.commit();
      const actions = plan === undefined ? [] : plan.kind === "insert"
        ? insertRestoreActions(insertResult?.rowIds ?? [])
        : restoreActions(plan.kind, plan.keyTerms, batch, before ?? [], after ?? []);
      const restoreId = input.editorSessionId && input.stepId && actions.length > 0
        ? this.stepRestores.create({ editorSessionId: input.editorSessionId, stepId: input.stepId,
          targetConnectionId: input.targetConnectionId, table: plan!.table, actions }) : undefined;
      return restoreId === undefined ? { affectedRows } : { affectedRows, restoreId };
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

  async restoreFlowStep(input: { restoreId: string }): Promise<{ affectedRows: number }> {
    const restore = this.stepRestores.require(input.restoreId);
    const profile = this.loadRunnableProfile(restore.targetConnectionId, "target");
    let target: DatabaseSession | undefined;
    let began = false;
    try {
      target = await this.connector.open(profile, await this.resolveCredential(profile));
      await target.begin(); began = true;
      let affectedRows = 0;
      for (const action of restore.actions) affectedRows += await applyRestoreAction(target, restore.table, action);
      if (affectedRows !== restore.actions.length) throw new MigrationRunnerError("RESTORE_CONFLICT", "target rows changed after run");
      await target.commit();
      this.stepRestores.discard(input.restoreId);
      return { affectedRows };
    } catch (error) {
      if (began && target) await target.rollback().catch(() => undefined);
      throw asMigrationRunnerError(error);
    } finally { await closeSessions(target); }
  }

  discardStepRestore(restoreId: string): void { this.stepRestores.discard(restoreId); }
  discardEditorRestores(editorSessionId: string): void { this.stepRestores.discardOwner(editorSessionId); }

  async startRun(flowId: string, onProgress?: RunProgressReporter): Promise<RunDto> {
    const flow = this.flows.loadFlow(flowId);
    if (flow === undefined) {
      throw new MigrationRunnerError("FLOW_NOT_FOUND", "flow not found");
    }
    const runId = randomUUID();


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
        return this.persistExistingPreflightFailure(runId, initialState, 0, portRunError(error), binding);
      }
      try {
        target = await this.connector.open(targetProfile, targetSecret);
      } catch (error) {
        return this.persistExistingPreflightFailure(runId, initialState, 0, portRunError(error), binding);
      }

      const batches: NamedRow[][] = [];
      for (let index = 0; index < flow.querySteps.length; index += 1) {
        try {
          batches.push(await preflightStep(source, targetProfile, flow.querySteps[index]));
        } catch (error) {
          return this.persistExistingPreflightFailure(runId, initialState, index, asRunError(error), binding);
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
          onProgress,
        );
      }
      return await this.executeAllOrNothing(runId, binding, initialState, target, batches, onProgress);
    } finally {
      await closeSessions(target, source);
    }
  }

  async recoverRun(request: RecoveryRequest, onProgress?: RunProgressReporter): Promise<RunDto> {
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
      return snapshot(request.runId, state, binding.flow);
    }
    if (request.type === "skip_and_continue") {
      return this.skipAndContinue(request.runId, state, pausedState, binding, onProgress);
    }
    return this.editAndRetry(request, state, pausedState, binding, failedStep, onProgress);
  }

  private async skipAndContinue(
    runId: string,
    state: RunState,
    pausedState: RunState,
    binding: RunBinding,
    onProgress?: RunProgressReporter,
  ): Promise<RunDto> {
    state.reserveRecovery("skip_and_continue");
    this.applyBoundRecovery(runId, state, pausedState, binding, binding);
    const reservedState = cloneState(state);
    state.applyReservedRecovery();
    if (state.status() === "completed") {
      this.applyBoundRecovery(runId, state, reservedState, binding, binding);
      return snapshot(runId, state, binding.flow);
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
        undefined,
        onProgress,
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
    onProgress?: RunProgressReporter,
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
        undefined,
        onProgress,
      );
    } finally {
      await closeSessions(sessions.target, sessions.source);
    }
  }

  private async executeAllOrNothing(
    runId: string,
    binding: RunBinding,
    initialState: RunState,
    target: DatabaseSession,
    batches: readonly NamedRow[][],
    onProgress?: RunProgressReporter,
  ): Promise<RunDto> {
    const state = initialState;
    try {
      await target.begin();
    } catch (error) {
      return this.persistExistingPreflightFailure(runId, state, 0, portRunError(error), binding);
    }
    for (let index = 0; index < binding.flow.querySteps.length; index += 1) {
      try {
        const affectedRows = await executeStepBatches(
          runId,
          index,
          binding.flow.querySteps[index].upsertSql,
          batches[index],
          target,
          onProgress,
        );
        state.recordStepSuccess(index, affectedRows);
      } catch (error) {
        state.recordStepFailure(index, executionRunError(error));
        try {
          await target.rollback();
        } catch (rollbackError) {
          state.markInDoubt(index, portRunError(rollbackError));
        }
        this.history.appendBoundRun(runId, state, binding);
        return snapshot(runId, state, binding.flow);
      }
    }
    if (binding.flow.querySteps.length > 0) {
      state.markCommitPending(binding.flow.querySteps.length - 1);
      this.history.appendBoundRun(runId, state, binding);
    }
    try {
      await target.commit();
    } catch (error) {
      const step = Math.max(0, binding.flow.querySteps.length - 1);
      state.markInDoubt(step, portRunError(error));
      try {
        await target.rollback();
      } catch (rollbackError) {
        state.markInDoubt(step, portRunError(rollbackError));
      }
      this.history.appendBoundRun(runId, state, binding);
      return snapshot(runId, state, binding.flow);
    }
    if (binding.flow.querySteps.length > 0) {
      state.confirmPendingCommit();
    }
    this.history.appendBoundRun(runId, state, binding);
    return snapshot(runId, state, binding.flow);
  }

  private async executeCommittedSteps(
    runId: string,
    binding: RunBinding,
    state: RunState,
    source: DatabaseSession,
    target: DatabaseSession,
    preparedBatches?: readonly NamedRow[][],
    onProgress?: RunProgressReporter,
  ): Promise<RunDto> {
    const currentStatus = state.status();
    if (currentStatus === "completed") {
      this.history.appendBoundRun(runId, state, binding);
      return snapshot(runId, state, binding.flow);
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
        return snapshot(runId, state, binding.flow);
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
        affectedRows = await executeStepBatches(
          runId,
          index,
          step.upsertSql,
          batch,
          target,
          onProgress,
        );
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
    return snapshot(runId, state, binding.flow);
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
    return snapshot(runId, state, binding.flow);
  }

  private createPreflightFailure(
    runId: string,
    flow: Flow,
    stepIndex: number,
    error: RunError,
  ): RunDto {
    const state = failedState(flow.transactionPolicy, flow.querySteps.length, stepIndex, error);
    this.history.createRunForFlow(runId, state, flow);
    return snapshot(runId, state, flow);
  }

  private persistExistingPreflightFailure(
    runId: string,
    initialState: RunState,
    stepIndex: number,
    error: RunError,
    binding?: RunBinding,
  ): RunDto {
    const state = failedState(initialState.policy(), initialState.steps().length, stepIndex, error);
    if (binding === undefined) this.history.appendRun(runId, state);
    else this.history.appendBoundRun(runId, state, binding);
    return snapshot(runId, state, binding?.flow);
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
    return snapshot(runId, state, binding.flow);
  }

  private async tryOpenBoundSessions(
    binding: RunBinding,
  ): Promise<{ source: DatabaseSession; target: DatabaseSession } | undefined> {
    if (binding.sourceProfile.kind !== this.connector.kind
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

async function executeStepBatches(
  runId: string,
  step: number,
  sql: string,
  rows: readonly NamedRow[],
  target: DatabaseSession,
  onProgress?: RunProgressReporter,
): Promise<number> {
  const totalBatches = Math.ceil(rows.length / RUN_BATCH_SIZE);
  let affectedRows = 0;
  let processedRows = 0;
  for (let offset = 0; offset < rows.length; offset += RUN_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + RUN_BATCH_SIZE);
    affectedRows += await target.executeNamed(sql, batch);
    processedRows += batch.length;
    onProgress?.({
      runId,
      step,
      processedRows,
      totalRows: rows.length,
      completedBatches: Math.ceil(processedRows / RUN_BATCH_SIZE),
      totalBatches,
    });
  }
  return affectedRows;
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
  return prepareRowSetBatch(rows, step);
}

function prepareRowSetBatch(rows: RowSet, step: QueryStep): NamedRow[] {
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

function coerceSavedPreviewBatch(
  rows: readonly NamedRow[],
  bindColumns: readonly TargetBindColumn[],
  columnKinds: Readonly<Record<string, "numeric" | "text">>,
): NamedRow[] {
  const bindKinds = completeBindKinds(bindColumns, columnKinds);
  if (bindKinds === undefined) return [...rows];
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([bindName, value]) => {
    const kind = bindKinds.get(bindName.toUpperCase());
    if (kind === undefined || value === null) return [bindName, value];
    return [bindName, kind === "numeric" ? coerceNumericPreviewValue(value) : textPreviewValue(value)];
  })));
}

// Temporal parts and raw bytes already carry their own bind type, so only a
// scalar is rendered as text for a non-numeric target column.
function textPreviewValue(value: Exclude<NamedRow[string], null>): NamedRow[string] {
  return typeof value === "object" ? value : String(value);
}

function completeBindKinds(
  bindColumns: readonly TargetBindColumn[],
  columnKinds: Readonly<Record<string, "numeric" | "text">>,
): Map<string, "numeric" | "text"> | undefined {
  const result = new Map<string, "numeric" | "text">();
  for (const { column, bindName } of bindColumns) {
    const kind = Object.entries(columnKinds).find(([name]) =>
      name.toUpperCase() === column.toUpperCase())?.[1];
    if (kind === undefined) return undefined;
    const key = bindName.toUpperCase();
    const existing = result.get(key);
    if (existing !== undefined && existing !== kind) return undefined;
    result.set(key, kind);
  }
  return result;
}

function coerceNumericPreviewValue(value: Exclude<NamedRow[string], null>): number | bigint {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
  } else if (typeof value === "bigint") {
    return value;
  } else if (typeof value === "string") {
    const canonical = canonicalDecimal(value);
    if (canonical !== undefined) {
      if (!canonical.includes(".")) {
        const numeric = Number(canonical);
        if (Number.isSafeInteger(numeric)) return numeric;
        return BigInt(canonical);
      }
      const numeric = Number(canonical);
      if (Number.isFinite(numeric) && canonicalDecimal(numeric.toString()) === canonical) return numeric;
    }
  }
  throw RunError.connector(
    "BIND_TYPE_UNSUPPORTED",
    "saved preview value is invalid for a numeric target column",
  );
}

function canonicalDecimal(value: string): string | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value.trim());
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) return undefined;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) return undefined;
  const digits = match[2] + (match[3] ?? "");
  const decimalPosition = match[2].length + exponent;
  const expanded = decimalPosition <= 0
    ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? digits + "0".repeat(decimalPosition - digits.length)
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [wholePart, fractionalPart = ""] = expanded.split(".");
  const whole = wholePart.replace(/^0+(?=\d)/u, "") || "0";
  const fractional = fractionalPart.replace(/0+$/u, "");
  const unsigned = fractional === "" ? whole : `${whole}.${fractional}`;
  return match[1] === "-" && unsigned !== "0" ? `-${unsigned}` : unsigned;
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

function snapshot(runId: string, state: RunState, flow?: Flow): RunDto {
  return {
    runId,
    policy: state.policy(),
    status: state.status(),
    steps: state.steps().map((step) => step.status),
    events: [...state.events()],
    stepTitles: flow === undefined ? [] : stepTitlesFor(flow),
  };
}

async function captureRestoreRows(
  target: DatabaseSession,
  table: string,
  keyTerms: readonly { column: string; bindName: string }[],
  columns: readonly string[],
  rows: readonly NamedRow[],
): Promise<NamedRow[]> {
  if (target.queryNamed === undefined || rows.length === 0 || keyTerms.length === 0) return [];
  const selection = ["ROWID AS DBR_RESTORE_ROWID", ...keyTerms.map((term) => term.column), ...columns]
    .filter((column, index, values) => values.findIndex((value) => value.toUpperCase() === column.toUpperCase()) === index)
    .join(", ");
  const where = keyTerms.map((term) => `${term.column} = :${term.bindName}`).join(" AND ");
  return (await target.queryNamed(`SELECT ${selection} FROM ${table} WHERE ${where}`, rows)).rows;
}

function restoreActions(
  kind: "insert" | "update" | "upsert",
  keyTerms: readonly { column: string; bindName: string }[],
  source: readonly NamedRow[],
  before: readonly NamedRow[],
  after: readonly NamedRow[],
): RestoreAction[] {
  return source.flatMap<RestoreAction>((row) => {
    const matches = (candidate: NamedRow) => keyTerms.every((term) => valueAt(candidate, term.column) === valueAt(row, term.bindName));
    const prior = before.find(matches);
    const current = after.find(matches);
    if (current === undefined) return [];
    const rowId = valueAt(current, "DBR_RESTORE_ROWID");
    if (typeof rowId !== "string") return [];
    const excluded = ["DBR_RESTORE_ROWID", ...keyTerms.map((term) => term.column)];
    const expected = withoutKeys(current, excluded);
    if (kind === "insert" || (kind === "upsert" && prior === undefined)) return [{ type: "delete", rowId, expected }];
    if (prior === undefined) return [];
    return [{ type: "update", rowId, expected, previous: withoutKeys(prior, excluded) }];
  });
}

function insertRestoreActions(rowIds: readonly string[]): RestoreAction[] {
  return rowIds.map((rowId) => ({ type: "delete" as const, rowId, expected: {} }));
}

function sqlReturningRowId(sql: string): string {
  return `${sql.trim()} RETURNING ROWID INTO :DBR_RESTORE_ROWID`;
}

function withoutKeys(row: NamedRow, excluded: readonly string[]): NamedRow {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.some((item) => item.toUpperCase() === key.toUpperCase())));
}

function valueAt(row: NamedRow, key: string) {
  return Object.entries(row).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1];
}

async function applyRestoreAction(target: DatabaseSession, table: string, action: RestoreAction): Promise<number> {
  const expectedEntries = Object.entries(action.expected);
  const expectedClause = expectedEntries.map(([column], index) =>
    `(${column} = :DBR_EXPECTED_${index} OR (${column} IS NULL AND :DBR_EXPECTED_${index} IS NULL))`).join(" AND ");
  const expectedBinds = Object.fromEntries(expectedEntries.map(([, value], index) =>
    [`DBR_EXPECTED_${index}`, value]));
  if (action.type === "delete") {
    return target.executeNamed(`DELETE FROM ${table} WHERE ROWID = :DBR_RESTORE_ROWID${expectedClause ? ` AND ${expectedClause}` : ""}`, [{
      DBR_RESTORE_ROWID: action.rowId,
      ...expectedBinds,
    }]);
  }
  const previousEntries = Object.entries(action.previous);
  const sets = previousEntries.map(([column], index) => `${column} = :DBR_PREVIOUS_${index}`).join(", ");
  return target.executeNamed(`UPDATE ${table} SET ${sets} WHERE ROWID = :DBR_RESTORE_ROWID${expectedClause ? ` AND ${expectedClause}` : ""}`, [{
    DBR_RESTORE_ROWID: action.rowId,
    ...Object.fromEntries(previousEntries.map(([, value], index) => [`DBR_PREVIOUS_${index}`, value])),
    ...expectedBinds,
  }]);
}

function stepTitlesFor(flow: Flow): string[] {
  return flow.querySteps.map((step, position) => step.title?.trim() || `Step ${position + 1}`);
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
