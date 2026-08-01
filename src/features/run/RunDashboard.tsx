import { useEffect, useMemo, useState } from "react";
import { listConnections } from "../connections/connections.api";
import type { Connection } from "../connections/connections.types";
import { listFlows } from "../flows/flows.api";
import type { Flow } from "../flows/flows.types";
import { RecoveryDialog } from "./RecoveryDialog";
import { RunLog } from "./RunLog";
import { recoverRun, startRun } from "./run.api";
import { affectedRows, failedStep, statusKind, stepKind, type Run } from "./run.types";

type Props = { run?: Run; initialFlows?: Flow[]; initialConnections?: Connection[] };

function policyLabel(policy: Flow["transactionPolicy"]): string {
  return policy === "all_or_nothing" ? "All or nothing" : "Commit successes";
}

export function RunDashboard({ run: suppliedRun, initialFlows, initialConnections }: Props) {
  const [flows, setFlows] = useState<Flow[]>(initialFlows ?? []);
  const [connections, setConnections] = useState<Connection[]>(initialConnections ?? []);
  const [flowId, setFlowId] = useState(initialFlows?.[0]?.id ?? "");
  const [run, setRun] = useState<Run | undefined>(suppliedRun);
  const [notice, setNotice] = useState<string>();
  const [executionDurationMs, setExecutionDurationMs] = useState<number>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (suppliedRun || (initialFlows && initialConnections)) return;
    void Promise.all([listFlows(), listConnections()]).then(([nextFlows, nextConnections]) => {
      setFlows(nextFlows); setConnections(nextConnections); setFlowId(nextFlows[0]?.id ?? "");
    }).catch(() => setNotice("Saved flows could not be loaded."));
  }, [suppliedRun, initialConnections, initialFlows]);

  const flow = useMemo(() => flows.find((item) => item.id === flowId), [flowId, flows]);
  const source = connections.find((item) => item.id === flow?.sourceConnectionId);
  const target = connections.find((item) => item.id === flow?.targetConnectionId);
  const preflightReady = Boolean(flow && source?.enabled && target?.enabled && source.id !== target.id && flow.querySteps.every((step) => step.selectSql.trim() && step.upsertSql.trim()));
  const elapsed = executionDurationMs === undefined ? "—" : `${Math.max(0, Math.round(executionDurationMs / 1000))}s`;
  const currentFailedStep = run ? failedStep(run) : undefined;
  const failedQuery = currentFailedStep === undefined ? undefined : flow?.querySteps[currentFailedStep];
  const awaitingRecovery = currentFailedStep !== undefined;

  const start = async () => {
    if (!flow || !preflightReady) return;
    try {
      setStarting(true);
      const startedAt = Date.now();
      setExecutionDurationMs(undefined);
      const completedRun = await startRun(flow.id);
      setExecutionDurationMs(Math.max(0, Date.now() - startedAt));
      setRun(completedRun);
      setNotice(undefined);
    }
    catch { setNotice("Preflight or execution failed. Review the run log and connection settings."); }
    finally { setStarting(false); }
  };
  const recover = async (request: Parameters<typeof recoverRun>[1]) => {
    if (!run) return;
    try { setRun(await recoverRun(run.runId, request)); setNotice(undefined); }
    catch { setNotice("Recovery could not be applied. Committed results remain unchanged."); }
  };

  return <section className="run-dashboard" aria-labelledby="run-dashboard-title">
    <div className="section-heading"><div><p className="app-page__eyebrow">Execution</p><h1 id="run-dashboard-title">실행</h1></div><button onClick={() => void start()} disabled={!preflightReady || awaitingRecovery || starting}>Run</button></div>
    {notice ? <p role="status">{notice}</p> : null}
    {!suppliedRun ? <label className="run-flow-picker">Saved flow<select value={flowId} disabled={awaitingRecovery} onChange={(event) => setFlowId(event.target.value)}><option value="">Choose a flow</option>{flows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
    {flow ? <div className="run-summary"><p><strong>Source:</strong> {source?.displayName ?? flow.sourceConnectionId}</p><p><strong>Target:</strong> {target?.displayName ?? flow.targetConnectionId}</p><p><strong>Policy:</strong> {policyLabel(flow.transactionPolicy)}</p><p><strong>Preflight:</strong> {preflightReady ? "Ready" : "Resolve flow and connection requirements before running."}</p></div> : null}
    {run ? <><div className="run-summary"><p><strong>Status:</strong> {statusKind(run.status).replace(/_/g, " ")}</p><p><strong>Processed:</strong> {run.steps.reduce((total, step) => total + affectedRows(step), 0)} rows</p><p><strong>Duration:</strong> {elapsed}</p></div><ol className="run-steps" aria-label="Query step results">{run.steps.map((step, index) => <li key={index}>Step {index + 1}: {stepKind(step).replace(/_/g, " ")}{affectedRows(step) ? ` (${affectedRows(step)} rows)` : ""}</li>)}</ol><RunLog events={run.events} />
      <RecoveryDialog run={run} step={failedQuery} onEditRetry={(sql) => currentFailedStep !== undefined ? recover({ type: "edit_and_retry", stepId: failedQuery?.id ?? String(currentFailedStep), ...sql }) : undefined} onSkip={() => currentFailedStep !== undefined ? recover({ type: "skip_and_continue", stepId: failedQuery?.id ?? String(currentFailedStep) }) : undefined} onStop={() => currentFailedStep !== undefined ? recover({ type: "stop", stepId: failedQuery?.id ?? String(currentFailedStep) }) : undefined} />
    </> : null}
  </section>;
}
