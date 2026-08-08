import { describe, expect, it } from "vitest";
import { RunError, RunState } from "./runState";

describe("RunState", () => {
  it("committed run pauses for user recovery after a step failure", () => {
    const state = RunState.running("commit_successes", 3);
    state.recordStepSuccess(0, 12);
    state.recordStepFailure(1, RunError.connector("ORA-00001", "unique constraint violated"));

    expect(state.status()).toEqual({ awaiting_recovery: { failed_step: 1 } });
    expect(state.steps()[0].status).toEqual({ succeeded: { affected_rows: 12 } });
    expect(state.steps()[1].status).toBe("failed");
  });

  it("stop after a committed step preserves success and marks remaining not run", () => {
    const state = RunState.awaitingRecoveryAfterStep(1, 3);
    state.applyRecovery("stop");

    expect(state.status()).toBe("stopped_by_user");
    expect(state.steps()[2].status).toBe("not_run");
  });

  it("skipping a failed step marks it skipped and runs the next step", () => {
    const state = RunState.awaitingRecoveryAfterStep(1, 3);
    state.applyRecovery("skip_and_continue");

    expect(state.steps()[1].status).toBe("skipped_by_user");
    expect(state.status()).toEqual({ running: { step: 2 } });
  });

  it("editing and retrying returns the run to the failed step", () => {
    const state = RunState.awaitingRecoveryAfterStep(1, 3);
    state.applyRecovery("edit_and_retry");

    expect(state.status()).toEqual({ running: { step: 1 } });
    expect(state.steps()[1].status).toBe("failed");
  });

  it("reserved recovery can be returned to awaiting user input", () => {
    const state = RunState.awaitingRecoveryAfterStep(1, 3);
    state.reserveRecovery("skip_and_continue");

    expect(state.status()).toEqual({
      recovery_pending: { failed_step: 1, action: "skip_and_continue" },
    });

    state.returnReservedRecoveryToAwaiting();
    expect(state.status()).toEqual({ awaiting_recovery: { failed_step: 1 } });
  });

  it("applies a reserved recovery action only after it is confirmed", () => {
    const state = RunState.awaitingRecoveryAfterStep(1, 3);
    state.reserveRecovery("skip_and_continue");
    state.applyReservedRecovery();

    expect(state.steps()[1].status).toBe("skipped_by_user");
    expect(state.status()).toEqual({ running: { step: 2 } });
    expect(state.events()).toContainEqual({
      type: "recovery_applied",
      step: 1,
      action: "skip_and_continue",
    });
  });

  it("rollback uncertainty blocks ordinary recovery", () => {
    const state = RunState.running("all_or_nothing", 1);
    state.recordStepFailure(0, RunError.connector("ORA-00001", "write failed"));
    state.markInDoubt(0, RunError.connector("ORA-03113", "rollback connection lost"));

    expect(state.status()).toMatchObject({ in_doubt: { step: 0 } });
    expect(() => state.applyRecovery("skip_and_continue")).toThrow(RunError);
  });

  it("recovery is rejected when the run is not awaiting user input", () => {
    const state = RunState.running("commit_successes", 1);

    const error = captureRunError(() => state.applyRecovery("stop"));
    expect(error).toMatchObject({
      type: "invalid_transition",
      detail: { status: { running: { step: 0 } }, action: "stop" },
    });
  });

  it("rejects a step other than the current running step", () => {
    const state = RunState.running("commit_successes", 2);

    const error = captureRunError(() => state.recordStepSuccess(1, 4));
    expect(error).toMatchObject({
      type: "invalid_step",
      detail: { expected: 0, received: 1 },
    });
  });

  it("rejects affected-row counts that cannot represent Rust u64 values", () => {
    const state = RunState.running("commit_successes", 1);

    expect(() => state.recordStepSuccess(0, -1))
      .toThrow("affected rows must be a non-negative integer");
    expect(state.status()).toEqual({ running: { step: 0 } });
    expect(state.steps()[0].status).toBe("not_run");
  });

  it("records and confirms the all-or-nothing commit checkpoint", () => {
    const state = RunState.running("all_or_nothing", 2);
    state.recordStepSuccess(0, 1);
    state.recordStepSuccess(1, 1);

    state.markCommitPending(1);
    expect(state.status()).toEqual({ commit_pending: { step: 1 } });

    state.confirmPendingCommit();
    expect(state.status()).toBe("completed");
  });

  it("allows a pending per-step commit to record success and advance", () => {
    const state = RunState.running("commit_successes", 2);
    state.markCommitPending(0);
    state.recordStepSuccess(0, 5);

    expect(state.steps()[0].status).toEqual({ succeeded: { affected_rows: 5 } });
    expect(state.status()).toEqual({ running: { step: 1 } });
  });

  it("connector errors mask named and supplied credential values", () => {
    const error = RunError.connectorWithCredentialValues(
      "ORA-01017",
      "connection failed: user id=scott password=top-secret token=abc123 for SCOTT",
      ["SCOTT", "top-secret", "abc123"],
    );
    const message = error.connectorMessage();

    expect(message).toContain("[REDACTED]");
    expect(message).not.toMatch(/scott|top-secret|abc123/i);
  });

  it("supplied credentials are masked longest first", () => {
    const error = RunError.connectorWithCredentialValues(
      "ORA-01017",
      "connection failed for admin123",
      ["admin", "admin123"],
    );

    expect(error.connectorMessage()).toBe("connection failed for [REDACTED]");
  });

  it("deserialized connector errors are masked before they are persisted", () => {
    const error = RunError.fromJSON({
      type: "connector",
      detail: { code: "ORA-01017", message: "password=raw-secret" },
    });
    const state = RunState.running("commit_successes", 1);
    state.recordStepFailure(0, error);

    const persisted = JSON.stringify(state.events());
    expect(persisted).not.toContain("raw-secret");
    expect(persisted).toContain("[REDACTED]");
  });

  it("preserves retryable connector errors and normalizes history codes", () => {
    const retryable = RunError.connectorWithRetryable(
      "ora-03113",
      "connection lost",
      true,
    );
    const generic = RunError.connector("DRIVER_TIMEOUT", "timed out");

    expect(retryable.retryable()).toBe(true);
    expect(retryable.historyCode()).toBe("ORA-03113");
    expect(generic.historyCode()).toBe("CONNECTOR_ERROR");
  });

  it("empty runs are completed without a running step", () => {
    const state = RunState.running("commit_successes", 0);

    expect(state.status()).toBe("completed");
    expect(state.steps()).toEqual([]);
  });

  it("awaiting recovery rejects an out-of-range failed step", () => {
    const error = captureRunError(() => RunState.awaitingRecoveryAfterStep(3, 3));

    expect(error).toMatchObject({
      type: "step_out_of_bounds",
      detail: { step: 3, step_count: 3 },
    });
  });

  it("malformed deserialized state rejects step failure without crashing", () => {
    const state = RunState.fromJSON({
      policy: "commit_successes",
      status: { running: { step: 0 } },
      steps: [],
      events: [],
    });

    const error = captureRunError(() => state.recordStepFailure(
      0,
      RunError.connector("ORA-00001", "constraint violated"),
    ));
    expect(error).toMatchObject({
      type: "step_out_of_bounds",
      detail: { step: 0, step_count: 0 },
    });
  });
});

function captureRunError(operation: () => unknown): RunError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RunError);
    return error as RunError;
  }
  throw new Error("expected operation to throw RunError");
}
