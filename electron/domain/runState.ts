import { maskSensitiveText } from "./errorMasking";
import type {
  ConnectorErrorData,
  RecoveryAction,
  RunErrorData,
  RunEvent,
  RunStateData,
  RunStatus,
  RunStep,
  StepStatus,
  TransactionPolicy,
} from "./models";

export class RunError extends Error {
  private readonly value: RunErrorData;

  private constructor(value: RunErrorData) {
    super(value.type);
    this.name = "RunError";
    this.value = freezeSnapshot(value);
  }

  get type(): RunErrorData["type"] {
    return this.value.type;
  }

  get detail(): RunErrorData["detail"] {
    return freezeSnapshot(this.value.detail);
  }

  static connector(code: string, message: string): RunError {
    return RunError.connectorWithRetryable(code, message, false);
  }

  static connectorWithRetryable(code: string, message: string, retryable: boolean): RunError {
    return new RunError({
      type: "connector",
      detail: { code, message: maskSensitiveText(message), retryable },
    });
  }

  static connectorWithCredentialValues(
    code: string,
    message: string,
    credentialValues: readonly string[],
    retryable = false,
  ): RunError {
    return new RunError({
      type: "connector",
      detail: {
        code,
        message: maskSensitiveText(message, credentialValues),
        retryable,
      },
    });
  }

  static invalidTransition(status: RunStatus, action: RecoveryAction): RunError {
    return new RunError({ type: "invalid_transition", detail: { status, action } });
  }

  static invalidStep(expected: number, received: number): RunError {
    return new RunError({ type: "invalid_step", detail: { expected, received } });
  }

  static stepOutOfBounds(step: number, stepCount: number): RunError {
    return new RunError({
      type: "step_out_of_bounds",
      detail: { step, step_count: stepCount },
    });
  }

  static fromJSON(input: unknown): RunError {
    if (input instanceof RunError) {
      return input;
    }
    const data = asRecord(input, "run error");
    const detail = asRecord(data.detail, "run error detail");

    switch (data.type) {
      case "connector":
        return RunError.connectorWithRetryable(
          asString(detail.code, "connector error code"),
          asString(detail.message, "connector error message"),
          detail.retryable === undefined
            ? false
            : asBoolean(detail.retryable, "connector retryable flag"),
        );
      case "invalid_transition":
        return RunError.invalidTransition(
          parseRunStatus(detail.status),
          parseRecoveryAction(detail.action),
        );
      case "invalid_step":
        return RunError.invalidStep(
          asNonNegativeInteger(detail.expected, "expected step"),
          asNonNegativeInteger(detail.received, "received step"),
        );
      case "step_out_of_bounds":
        return RunError.stepOutOfBounds(
          asNonNegativeInteger(detail.step, "step"),
          asNonNegativeInteger(detail.step_count, "step count"),
        );
      default:
        throw new TypeError("unknown run error type");
    }
  }

  connectorMessage(): string | undefined {
    return this.value.type === "connector" ? this.value.detail.message : undefined;
  }

  retryable(): boolean {
    return this.value.type === "connector" && this.value.detail.retryable;
  }

  historyCode(): string {
    switch (this.value.type) {
      case "connector":
        return /^ORA-[0-9]{5}$/i.test(this.value.detail.code)
          ? this.value.detail.code.toUpperCase()
          : "CONNECTOR_ERROR";
      case "invalid_transition":
        return "INVALID_TRANSITION";
      case "invalid_step":
        return "INVALID_STEP";
      case "step_out_of_bounds":
        return "STEP_OUT_OF_BOUNDS";
    }
  }

  toJSON(): RunErrorData {
    return freezeSnapshot(this.value);
  }
}

export class RunState {
  private readonly transactionPolicy: TransactionPolicy;
  private runStatus: RunStatus;
  private readonly runSteps: RunStep[];
  private readonly runEvents: RunEvent[];

  private constructor(
    transactionPolicy: TransactionPolicy,
    runStatus: RunStatus,
    runSteps: RunStep[],
    runEvents: RunEvent[],
  ) {
    this.transactionPolicy = transactionPolicy;
    this.runStatus = runStatus;
    this.runSteps = runSteps;
    this.runEvents = runEvents.map((event) => freezeSnapshot(event));
  }

  static running(policy: TransactionPolicy, stepCount: number): RunState {
    requireNonNegativeInteger(stepCount, "step count");
    return new RunState(
      policy,
      stepCount === 0 ? "completed" : { running: { step: 0 } },
      Array.from({ length: stepCount }, () => ({ status: "not_run" as const })),
      [],
    );
  }

  static awaitingRecoveryAfterStep(failedStep: number, stepCount: number): RunState {
    const state = RunState.running("commit_successes", stepCount);
    state.validateStep(failedStep);
    state.runSteps[failedStep].status = "failed";
    state.runStatus = { awaiting_recovery: { failed_step: failedStep } };
    return state;
  }

  static fromHistory(
    policy: TransactionPolicy,
    status: RunStatus,
    stepStatuses: readonly StepStatus[],
    events: readonly RunEvent[],
  ): RunState {
    return new RunState(
      policy,
      parseRunStatus(status),
      stepStatuses.map((stepStatus) => ({ status: parseStepStatus(stepStatus) })),
      events.map(parseRunEvent),
    );
  }

  static fromJSON(input: unknown): RunState {
    const parsed = typeof input === "string" ? JSON.parse(input) as unknown : input;
    const data = asRecord(parsed, "run state");
    const policy = parseTransactionPolicy(data.policy);
    const status = parseRunStatus(data.status);
    const steps = asArray(data.steps, "run steps").map((item) => {
      const step = asRecord(item, "run step");
      return { status: parseStepStatus(step.status) };
    });
    const events = asArray(data.events, "run events").map(parseRunEvent);
    return new RunState(policy, status, steps, events);
  }

  status(): RunStatus {
    return freezeSnapshot(cloneRunStatus(this.runStatus));
  }

  policy(): TransactionPolicy {
    return this.transactionPolicy;
  }

  steps(): readonly RunStep[] {
    return freezeSnapshot(this.runSteps);
  }

  events(): readonly RunEvent[] {
    return freezeSnapshot(this.runEvents);
  }

  recordStepSuccess(step: number, affectedRows: number): void {
    asNonNegativeInteger(affectedRows, "affected rows");
    this.requireRunningStep(step);
    this.validateStep(step);
    this.runSteps[step].status = { succeeded: { affected_rows: affectedRows } };
    this.recordEvent({ type: "step_succeeded", step, affected_rows: affectedRows });
    this.advanceAfterSuccess();
  }

  recordStepFailure(step: number, error: RunError): void {
    this.requireRunningStep(step);
    this.runSteps[step].status = "failed";
    this.recordEvent({ type: "step_failed", step, error: error.toJSON() });
    this.runStatus = this.transactionPolicy === "commit_successes"
      ? { awaiting_recovery: { failed_step: step } }
      : "rolled_back";
  }

  applyRecovery(action: RecoveryAction): void {
    const failedStep = awaitingRecoveryStep(this.runStatus);
    if (failedStep === undefined) {
      throw RunError.invalidTransition(this.status(), action);
    }
    this.validateStep(failedStep);
    this.applyRecoveryAtStep(failedStep, action);
  }

  reserveRecovery(action: RecoveryAction): void {
    const failedStep = awaitingRecoveryStep(this.runStatus);
    if (failedStep === undefined) {
      throw RunError.invalidTransition(this.status(), action);
    }
    this.validateStep(failedStep);
    this.runStatus = { recovery_pending: { failed_step: failedStep, action } };
  }

  returnReservedRecoveryToAwaiting(): void {
    const pending = pendingRecovery(this.runStatus);
    if (pending === undefined) {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    this.validateStep(pending.failedStep);
    this.runStatus = { awaiting_recovery: { failed_step: pending.failedStep } };
  }

  applyReservedRecovery(): void {
    const pending = pendingRecovery(this.runStatus);
    if (pending === undefined) {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    this.validateStep(pending.failedStep);
    this.applyRecoveryAtStep(pending.failedStep, pending.action);
  }

  markCommitPending(step: number): void {
    this.validateStep(step);
    const running = currentStep(this.runStatus);
    const canMark = running?.kind === "running" && running.step === step
      || this.runStatus === "completed" && step + 1 === this.runSteps.length;
    if (!canMark) {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    this.runStatus = { commit_pending: { step } };
  }

  confirmPendingCommit(): void {
    const current = currentStep(this.runStatus);
    if (current?.kind !== "commit_pending") {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    this.validateStep(current.step);
    this.runStatus = "completed";
  }

  markInDoubt(step: number, reason: RunError): void {
    this.validateStep(step);
    this.recordEvent({ type: "transaction_failed", error: reason.toJSON() });
    this.runStatus = { in_doubt: { step, reason: reason.toJSON() } };
  }

  advanceAfterSuccess(): void {
    const current = currentStep(this.runStatus);
    if (current === undefined) {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    this.validateStep(current.step);
    this.runStatus = current.step === this.runSteps.length - 1
      ? "completed"
      : { running: { step: current.step + 1 } };
  }

  toJSON(): RunStateData {
    return freezeSnapshot({
      policy: this.transactionPolicy,
      status: this.runStatus,
      steps: this.runSteps,
      events: this.runEvents,
    });
  }

  private applyRecoveryAtStep(failedStep: number, action: RecoveryAction): void {
    this.recordEvent({ type: "recovery_applied", step: failedStep, action });
    switch (action) {
      case "edit_and_retry":
        this.runStatus = { running: { step: failedStep } };
        break;
      case "skip_and_continue":
        this.validateStep(failedStep);
        this.runSteps[failedStep].status = "skipped_by_user";
        this.runStatus = failedStep + 1 === this.runSteps.length
          ? "completed"
          : { running: { step: failedStep + 1 } };
        break;
      case "stop":
        this.runStatus = "stopped_by_user";
        break;
    }
  }

  private requireRunningStep(step: number): void {
    const current = currentStep(this.runStatus);
    if (current === undefined) {
      throw RunError.invalidTransition(this.status(), "edit_and_retry");
    }
    if (current.step !== step) {
      throw RunError.invalidStep(current.step, step);
    }
    this.validateStep(step);
  }

  private validateStep(step: number): void {
    if (!Number.isInteger(step) || step < 0 || step >= this.runSteps.length) {
      throw RunError.stepOutOfBounds(step, this.runSteps.length);
    }
  }

  private recordEvent(event: RunEvent): void {
    this.runEvents.push(freezeSnapshot(event));
  }
}

function currentStep(status: RunStatus): { kind: "running" | "commit_pending"; step: number } | undefined {
  if (typeof status === "object" && "running" in status) {
    return { kind: "running", step: status.running.step };
  }
  if (typeof status === "object" && "commit_pending" in status) {
    return { kind: "commit_pending", step: status.commit_pending.step };
  }
  return undefined;
}

function awaitingRecoveryStep(status: RunStatus): number | undefined {
  return typeof status === "object" && "awaiting_recovery" in status
    ? status.awaiting_recovery.failed_step
    : undefined;
}

function pendingRecovery(
  status: RunStatus,
): { failedStep: number; action: RecoveryAction } | undefined {
  return typeof status === "object" && "recovery_pending" in status
    ? {
      failedStep: status.recovery_pending.failed_step,
      action: status.recovery_pending.action,
    }
    : undefined;
}

function parseRunStatus(input: unknown): RunStatus {
  if (typeof input === "string") {
    if (["draft", "validating", "completed", "rolled_back", "stopped_by_user", "failed"]
      .includes(input)) {
      return input as RunStatus;
    }
    throw new TypeError("unknown run status");
  }

  const status = asRecord(input, "run status");
  if ("running" in status) {
    const detail = asRecord(status.running, "running status");
    return { running: { step: asNonNegativeInteger(detail.step, "running step") } };
  }
  if ("awaiting_recovery" in status) {
    const detail = asRecord(status.awaiting_recovery, "awaiting recovery status");
    return {
      awaiting_recovery: {
        failed_step: asNonNegativeInteger(detail.failed_step, "failed step"),
      },
    };
  }
  if ("recovery_pending" in status) {
    const detail = asRecord(status.recovery_pending, "recovery pending status");
    return {
      recovery_pending: {
        failed_step: asNonNegativeInteger(detail.failed_step, "failed step"),
        action: parseRecoveryAction(detail.action),
      },
    };
  }
  if ("commit_pending" in status) {
    const detail = asRecord(status.commit_pending, "commit pending status");
    return { commit_pending: { step: asNonNegativeInteger(detail.step, "commit step") } };
  }
  if ("in_doubt" in status) {
    const detail = asRecord(status.in_doubt, "in doubt status");
    return {
      in_doubt: {
        step: asNonNegativeInteger(detail.step, "in-doubt step"),
        reason: RunError.fromJSON(detail.reason).toJSON(),
      },
    };
  }
  throw new TypeError("unknown run status");
}

function cloneRunStatus(status: RunStatus): RunStatus {
  return parseRunStatus(status);
}

function parseStepStatus(input: unknown): StepStatus {
  if (input === "not_run" || input === "failed" || input === "skipped_by_user") {
    return input;
  }
  const status = asRecord(input, "step status");
  if ("succeeded" in status) {
    const detail = asRecord(status.succeeded, "succeeded step status");
    return {
      succeeded: {
        affected_rows: asNonNegativeInteger(detail.affected_rows, "affected rows"),
      },
    };
  }
  throw new TypeError("unknown step status");
}

function parseRunEvent(input: unknown): RunEvent {
  const event = asRecord(input, "run event");
  switch (event.type) {
    case "step_succeeded":
      return {
        type: "step_succeeded",
        step: asNonNegativeInteger(event.step, "event step"),
        affected_rows: asNonNegativeInteger(event.affected_rows, "affected rows"),
      };
    case "step_failed":
      return {
        type: "step_failed",
        step: asNonNegativeInteger(event.step, "event step"),
        error: RunError.fromJSON(event.error).toJSON(),
      };
    case "transaction_failed":
      return { type: "transaction_failed", error: RunError.fromJSON(event.error).toJSON() };
    case "recovery_applied":
      return {
        type: "recovery_applied",
        step: asNonNegativeInteger(event.step, "event step"),
        action: parseRecoveryAction(event.action),
      };
    default:
      throw new TypeError("unknown run event type");
  }
}

function parseTransactionPolicy(input: unknown): TransactionPolicy {
  if (input === "all_or_nothing" || input === "commit_successes") {
    return input;
  }
  throw new TypeError("unknown transaction policy");
}

function parseRecoveryAction(input: unknown): RecoveryAction {
  if (input === "edit_and_retry" || input === "skip_and_continue" || input === "stop") {
    return input;
  }
  throw new TypeError("unknown recovery action");
}

function asRecord(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

function asArray(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${name} must be an array`);
  }
  return input;
}

function asString(input: unknown, name: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return input;
}

function asBoolean(input: unknown, name: string): boolean {
  if (typeof input !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return input;
}

function asNonNegativeInteger(input: unknown, name: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return input;
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeSnapshot(item))) as T;
  }

  const snapshot = Object.create(
    Object.getPrototypeOf(value) === null ? null : Object.prototype,
  ) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(snapshot, key, {
      value: freezeSnapshot(item),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot) as T;
}

function requireNonNegativeInteger(input: number, name: string): void {
  asNonNegativeInteger(input, name);
}

export type {
  ConnectorErrorData,
  RecoveryAction,
  RunErrorData,
  RunEvent,
  RunStateData,
  RunStatus,
  RunStep,
  StepStatus,
  TransactionPolicy,
} from "./models";
