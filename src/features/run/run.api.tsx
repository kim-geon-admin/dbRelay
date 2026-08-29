import { invokeCommand, subscribeToRunProgress, type RunProgressDto } from "../../lib/desktop";
import type { RecoveryRequest, Run } from "./run.types";

export type RunProgress = RunProgressDto;

export function subscribeRunProgress(listener: (progress: RunProgress) => void): () => void {
  return subscribeToRunProgress(listener);
}

export function startRun(flowId: string): Promise<Run> {
  return invokeCommand("start_run", { request: { flowId } });
}

export function recoverRun(runId: string, request: RecoveryRequest): Promise<Run> {
  switch (request.type) {
    case "edit_and_retry":
      return invokeCommand("recover_run", { request: { type: request.type, run_id: runId, step_id: request.stepId, select_sql: request.selectSql, upsert_sql: request.upsertSql } });
    case "skip_and_continue":
    case "stop":
      return invokeCommand("recover_run", { request: { type: request.type, run_id: runId, step_id: request.stepId } });
  }
}
