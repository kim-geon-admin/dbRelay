import { affectedRows, statusKind, stepKind } from "../run/run.types";
import type { HistoryRun } from "./history.types";

function eventLabel(event: HistoryRun["events"][number]): string {
  if (event.type === "recovery_applied") return `Step ${event.step + 1}: ${event.action === "skip_and_continue" ? "SkippedByUser" : event.action.replace(/_/g, " ")}`;
  if (event.type === "step_succeeded") return `Step ${event.step + 1}: committed ${event.affected_rows} rows`;
  if (event.type === "step_failed") return `Step ${event.step + 1}: failed${event.error.connector ? ` (${event.error.connector.code})` : ""}`;
  return `Transaction failed${event.error.connector ? ` (${event.error.connector.code})` : ""}`;
}

export function RunDetail({ run }: { run: HistoryRun }) {
  return <article className="history-detail" aria-label={`Run ${run.runId}`}><h2>{run.runId}</h2><p>Status: {statusKind(run.status).replace(/_/g, " ")}</p><p>Policy: {run.policy.replace(/_/g, " ")}</p><ol>{run.steps.map((step, index) => <li key={index}>Step {index + 1}: {stepKind(step).replace(/_/g, " ")}{affectedRows(step) ? ` (${affectedRows(step)} rows)` : ""}</li>)}</ol><h3>Recovery events</h3><ul>{run.events.map((event, index) => <li key={index}>{eventLabel(event)}</li>)}</ul></article>;
}
