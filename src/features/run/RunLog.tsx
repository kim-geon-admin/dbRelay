import type { RunEvent } from "./run.types";

function eventText(event: RunEvent): string {
  if (event.type === "step_succeeded") return `Step ${event.step + 1}: committed ${event.affected_rows} rows.`;
  if (event.type === "step_failed") return `Step ${event.step + 1}: failed${connectorDetail(event.error)}.`;
  if (event.type === "transaction_failed") return `Transaction failed${connectorDetail(event.error)}.`;
  return `Step ${event.step + 1}: ${event.action.replace(/_/g, " ")}.`;
}

function connectorDetail(error: Extract<RunEvent, { type: "step_failed" | "transaction_failed" }>['error']): string {
  return error.type === "connector" ? ` (${error.detail.code}: ${error.detail.message})` : "";
}

export function RunLog({ events }: { events: RunEvent[] }) {
  return <section className="run-log" aria-labelledby="run-log-title"><h2 id="run-log-title">Run log</h2><pre aria-live="polite">{events.length ? events.map(eventText).join("\n") : "Waiting for a run."}</pre></section>;
}
