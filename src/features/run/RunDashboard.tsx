import { useEffect, useMemo, useRef, useState } from "react";
import { listConnections } from "../connections/connections.api";
import type { Connection } from "../connections/connections.types";
import { listFlows } from "../flows/flows.api";
import { transactionPolicyLabel, type Flow } from "../flows/flows.types";
import { RecoveryDialog } from "./RecoveryDialog";
import { RunLog } from "./RunLog";
import { recoverRun, startRun, subscribeRunProgress, type RunProgress } from "./run.api";
import { affectedRows, failedStep, statusKind, stepKind, stepLabel, type Run } from "./run.types";

type Props = { run?: Run; initialFlows?: Flow[]; initialConnections?: Connection[] };

export function RunDashboard({ run: suppliedRun, initialFlows, initialConnections }: Props) {
  const [flows, setFlows] = useState<Flow[]>(initialFlows ?? []);
  const [connections, setConnections] = useState<Connection[]>(initialConnections ?? []);
  const [flowId, setFlowId] = useState(initialFlows?.[0]?.id ?? "");
  const [nameFilter, setNameFilter] = useState("");
  const [run, setRun] = useState<Run | undefined>(suppliedRun);
  const [notice, setNotice] = useState<string>();
  const [executionDurationMs, setExecutionDurationMs] = useState<number>();
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<RunProgress>();
  const activeRunRef = useRef<{ runId?: string } | undefined>(undefined);

  useEffect(() => {
    if (suppliedRun || (initialFlows && initialConnections)) return;
    void Promise.all([listFlows(), listConnections()]).then(([nextFlows, nextConnections]) => {
      setFlows(nextFlows); setConnections(nextConnections); setFlowId(nextFlows[0]?.id ?? "");
    }).catch(() => setNotice("Saved flows could not be loaded."));
  }, [suppliedRun, initialConnections, initialFlows]);

  useEffect(() => subscribeRunProgress((update) => {
    const activeRun = activeRunRef.current;
    if (activeRun === undefined || (activeRun.runId !== undefined && activeRun.runId !== update.runId)) return;
    setProgress(update);
  }), []);

  const filteredFlows = useMemo(() => {
    return flows.filter((item) => item.name.toLocaleLowerCase().includes(nameFilter.trim().toLocaleLowerCase()));
  }, [flows, nameFilter]);
  const flow = useMemo(() => flows.find((item) => item.id === flowId), [flowId, flows]);
  const source = connections.find((item) => item.id === flow?.sourceConnectionId);
  const target = connections.find((item) => item.id === flow?.targetConnectionId);
  const preflightReady = Boolean(flow && source?.enabled && target?.enabled && flow.querySteps.every((step) => step.selectSql.trim() && step.upsertSql.trim()));
  const elapsed = executionDurationMs === undefined ? "—" : `${Math.max(0, Math.round(executionDurationMs / 1000))}s`;
  const currentFailedStep = run ? failedStep(run) : undefined;
  const failedQuery = currentFailedStep === undefined ? undefined : flow?.querySteps[currentFailedStep];
  const awaitingRecovery = currentFailedStep !== undefined;

  const start = async () => {
    if (!flow || !preflightReady) return;
    try {
      setStarting(true);
      activeRunRef.current = {};
      setProgress(undefined);
      const startedAt = Date.now();
      setExecutionDurationMs(undefined);
      const completedRun = await startRun(flow.id);
      setExecutionDurationMs(Math.max(0, Date.now() - startedAt));
      setRun(completedRun);
      setNotice(undefined);
    }
    catch { setNotice("Preflight or execution failed. Review the run log and connection settings."); }
    finally {
      activeRunRef.current = undefined;
      setProgress(undefined);
      setStarting(false);
    }
  };
  const recover = async (request: Parameters<typeof recoverRun>[1]) => {
    if (!run) return;
    try {
      activeRunRef.current = { runId: run.runId };
      setProgress(undefined);
      setRun(await recoverRun(run.runId, request));
      setNotice(undefined);
    }
    catch { setNotice("Recovery could not be applied. Committed results remain unchanged."); }
    finally {
      activeRunRef.current = undefined;
      setProgress(undefined);
    }
  };
  const filterFlowsByName = (nextNameFilter: string) => {
    setNameFilter(nextNameFilter);
    const selectedFlow = flows.find((item) => item.id === flowId);
    if (selectedFlow && !selectedFlow.name.toLocaleLowerCase().includes(nextNameFilter.trim().toLocaleLowerCase())) setFlowId("");
  };

  return <section className="run-dashboard" aria-labelledby="run-dashboard-title">
    <div className="section-heading"><div><p className="app-page__eyebrow">Execution</p><h1 id="run-dashboard-title">실행</h1></div><button onClick={() => void start()} disabled={!preflightReady || awaitingRecovery || starting}>Run</button></div>
    {notice ? <p role="status">{notice}</p> : null}
    {!suppliedRun ? <><div className="flow-list__filter"><input aria-label="Filter saved flows by name" placeholder="Search flow names" value={nameFilter} onChange={(event) => filterFlowsByName(event.target.value)} /></div><label className="run-flow-picker">Saved flow<select value={flowId} disabled={awaitingRecovery} onChange={(event) => setFlowId(event.target.value)}><option value="">Choose a flow</option>{filteredFlows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></> : null}
    {flow ? <div className="run-summary"><p><strong>Source:</strong> {source?.displayName ?? flow.sourceConnectionId}</p><p><strong>Target:</strong> {target?.displayName ?? flow.targetConnectionId}</p><p><strong>Policy:</strong> {transactionPolicyLabel(flow.transactionPolicy)}</p><p><strong>Preflight:</strong> {preflightReady ? "Ready" : "Resolve flow and connection requirements before running."}</p></div> : null}
    {progress ? <section className="run-progress" aria-live="polite" aria-label="실행 진행률"><strong>실행 중 · {progress.step + 1}단계</strong><span>{progress.processedRows.toLocaleString()} / {progress.totalRows.toLocaleString()}건 처리됨 · 배치 {progress.completedBatches}/{progress.totalBatches}</span><progress value={progress.processedRows} max={progress.totalRows} /></section> : null}
    {run ? <><div className="run-summary"><p><strong>Status:</strong> {statusKind(run.status).replace(/_/g, " ")}</p><p><strong>Processed:</strong> {run.steps.reduce((total, step) => total + affectedRows(step), 0)} rows</p><p><strong>Duration:</strong> {elapsed}</p></div><ol className="run-steps" aria-label="Query step results">{run.steps.map((step, index) => <li key={index}>{stepLabel(run.stepTitles, index)}: {stepKind(step).replace(/_/g, " ")}{affectedRows(step) ? ` (${affectedRows(step)} rows)` : ""}</li>)}</ol><RunLog events={run.events} stepTitles={run.stepTitles} />
      <RecoveryDialog run={run} step={failedQuery} onEditRetry={(sql) => currentFailedStep !== undefined ? recover({ type: "edit_and_retry", stepId: failedQuery?.id ?? String(currentFailedStep), ...sql }) : undefined} onSkip={() => currentFailedStep !== undefined ? recover({ type: "skip_and_continue", stepId: failedQuery?.id ?? String(currentFailedStep) }) : undefined} onStop={() => currentFailedStep !== undefined ? recover({ type: "stop", stepId: failedQuery?.id ?? String(currentFailedStep) }) : undefined} />
    </> : null}
  </section>;
}
