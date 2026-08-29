import { affectedRows, formatRecoveryAction, formatRunStatus, stepKind, stepLabel } from "../run/run.types";
import type { HistoryRun } from "./history.types";
import { transactionPolicyLabel } from "../flows/flows.types";
import { formatConnectorError } from "../../lib/oracleErrors";
import { formatHistoryDateTime } from "./historyTime";

function eventLabel(run: HistoryRun, event: HistoryRun["events"][number]): string {
  if (event.type === "recovery_applied") return `${stepLabel(run.stepTitles, event.step)}: ${formatRecoveryAction(event.action)}`;
  if (event.type === "step_succeeded") return `${stepLabel(run.stepTitles, event.step)}: committed ${event.affected_rows} rows`;
  if (event.type === "step_failed") return `${stepLabel(run.stepTitles, event.step)}: failed${connectorDetail(event.error)}`;
  return `Transaction failed${connectorDetail(event.error)}`;
}

function connectorDetail(error: Extract<HistoryRun["events"][number], { type: "step_failed" | "transaction_failed" }>['error']): string {
  return error.type === "connector" ? ` (${formatConnectorError(error.detail.code, error.detail.message)})` : "";
}

export function RunDetail({ run }: { run: HistoryRun }) {
  const heading = [run.sourceDbName, run.targetDbName, run.flowName].filter(Boolean).join(" - ");
  return <article className="history-detail" aria-label={`Run ${run.runId}`}><h2>{heading}</h2><p>Started: {formatHistoryDateTime(run.startedAt)}</p><p>Ended: {run.endedAt === null ? "In progress" : formatHistoryDateTime(run.endedAt)}</p><p>Status: {formatRunStatus(run.status)}</p><p>Policy: {transactionPolicyLabel(run.policy)}</p><ol>{run.steps.map((step, index) => <li key={index}>{stepLabel(run.stepTitles, index)}: {stepKind(step).replace(/_/g, " ")}{affectedRows(step) ? ` (${affectedRows(step)} rows)` : ""}</li>)}</ol><h3>Recovery events</h3><ul>{run.events.map((event, index) => <li key={index}>{eventLabel(run, event)}</li>)}</ul></article>;
}
