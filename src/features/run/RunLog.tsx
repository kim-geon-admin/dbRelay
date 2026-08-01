import type { RunEvent } from "./run.types";

function eventText(event: RunEvent): string {
  if (event.type === "step_succeeded") return `Step ${event.step + 1}: committed ${event.affected_rows} rows.`;
  if (event.type === "step_failed") return `Step ${event.step + 1}: failed${event.error.connector ? ` (${event.error.connector.code})` : ""}.`;
  if (event.type === "transaction_failed") return `Transaction failed${event.error.connector ? ` (${event.error.connector.code})` : ""}.`;
  return `Step ${event.step + 1}: ${event.action.replace(/_/g, " ")}.`;
}

export function RunLog({ events }: { events: RunEvent[] }) {
  return <section className="run-log" aria-labelledby="run-log-title"><h2 id="run-log-title">Run log</h2><pre aria-live="polite">{events.length ? events.map(eventText).join("\n") : "Waiting for a run."}</pre></section>;
}
