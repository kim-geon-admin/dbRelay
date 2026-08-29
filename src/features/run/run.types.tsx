import type { RunDto, RunEventDto, RunStatusDto, StepStatusDto } from "../../lib/desktop";

export type Run = RunDto;
export type RunStatus = RunStatusDto;
export type StepStatus = StepStatusDto;
export type RunEvent = RunEventDto;

export type RecoveryRequest =
  | { type: "edit_and_retry"; stepId: string; selectSql: string; upsertSql: string }
  | { type: "skip_and_continue"; stepId: string }
  | { type: "stop"; stepId: string };

export function statusKind(status: RunStatus): string {
  return typeof status === "string" ? status : Object.keys(status)[0] ?? "failed";
}

export function formatRunStatus(status: RunStatus): string {
  return statusKind(status).replace(/_/g, " ");
}

export function formatRecoveryAction(action: Extract<RunEvent, { type: "recovery_applied" }>['action']): string {
  if (action === "skip_and_continue") return "skipped by user";
  if (action === "stop") return "stopped by user";
  return "edit and retry";
}

export function failedStep(run: Run): number | undefined {
  return typeof run.status === "object" && "awaiting_recovery" in run.status
    ? run.status.awaiting_recovery.failed_step
    : undefined;
}

export function stepKind(step: StepStatus): string {
  return typeof step === "string" ? step : "succeeded";
}

export function affectedRows(step: StepStatus): number {
  return typeof step === "object" && "succeeded" in step ? step.succeeded.affected_rows : 0;
}

export function stepLabel(stepTitles: readonly string[] | undefined, step: number): string {
  return stepTitles?.[step]?.trim() || `Step ${step + 1}`;
}

export function recoveryFailure(run: Run, step: number) {
  const event = [...run.events].reverse().find((item) => item.type === "step_failed" && item.step === step);
  return event?.type === "step_failed" && event.error.type === "connector" ? event.error.detail : undefined;
}
