import { formatRecoveryAction, stepLabel, type RunEvent } from "./run.types";
import { formatConnectorError } from "../../lib/oracleErrors";

function eventText(event: RunEvent, stepTitles?: readonly string[]): string {
  if (event.type === "step_succeeded") return `${stepLabel(stepTitles, event.step)}단계: ${event.affected_rows}행 커밋 완료.`;
  if (event.type === "step_failed") return failureText(
    `${stepLabel(stepTitles, event.step)}단계 실행 실패`,
    event.error,
  );
  if (event.type === "transaction_failed") return failureText(
    "트랜잭션 실행 실패",
    event.error,
  );
  return `${stepLabel(stepTitles, event.step)}단계: ${recoveryActionLabel(event.action)}.`;
}

function failureText(
  korean: string,
  error: Extract<RunEvent, { type: "step_failed" | "transaction_failed" }>['error'],
): string {
  if (error.type === "connector" && /^ORA-\d{5}$/u.test(error.detail.code)) {
    const code = error.detail.code;
    return `${korean} — Oracle 오류 코드: ${code}.\n${formatConnectorError(code, error.detail.message)}.`;
  }
  return `${korean}${connectorDetail(error)}.`;
}

function recoveryActionLabel(action: Extract<RunEvent, { type: "recovery_applied" }>['action']): string {
  return formatRecoveryAction(action);
}

function legacyRecoveryActionLabel(action: Extract<RunEvent, { type: "recovery_applied" }>['action']): string {
  if (action === "edit_and_retry") return "수정 후 재시도";
  if (action === "skip_and_continue") return "건너뛰고 계속";
  return "실행 중지";
}

function connectorDetail(error: Extract<RunEvent, { type: "step_failed" | "transaction_failed" }>['error']): string {
  return error.type === "connector" ? ` (${formatConnectorError(error.detail.code, error.detail.message)})` : "";
}

export function RunLog({ events, stepTitles }: { events: RunEvent[]; stepTitles?: readonly string[] }) {
  return <section className="run-log" aria-labelledby="run-log-title"><h2 id="run-log-title">Run log</h2><pre aria-live="polite">{events.length ? events.map((event) => eventText(event, stepTitles)).join("\n") : "실행을 기다리는 중입니다."}</pre></section>;
}
