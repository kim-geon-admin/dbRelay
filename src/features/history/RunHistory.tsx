import { useEffect, useState } from "react";
import { clearRunHistory, deleteRunHistory, listRunHistory } from "./history.api";
import { RunDetail } from "./RunDetail";
import type { HistoryRun } from "./history.types";
import { formatRunStatus, statusKind } from "../run/run.types";
import { formatHistoryDateTime } from "./historyTime";
import { ConfirmDialog } from "../../components/ConfirmDialog";

function canDelete(run: HistoryRun): boolean {
  return ["completed", "rolled_back", "stopped_by_user", "failed", "in_doubt"].includes(statusKind(run.status));
}

type PendingConfirmation = { type: "run"; run: HistoryRun } | { type: "all" };

export function RunHistory() {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  useEffect(() => {
    void listRunHistory().then((entries) => {
      setRuns([...entries].sort((left, right) => right.startedAt - left.startedAt || right.runId.localeCompare(left.runId)));
    }).catch(() => setNotice("Run history could not be loaded."));
  }, []);

  const remove = async (run: HistoryRun) => {
    try {
      await deleteRunHistory(run.runId);
      const remaining = runs.filter((item) => item.runId !== run.runId);
      setRuns(remaining);
      if (selectedId === run.runId) setSelectedId(remaining[0]?.runId);
      setNotice("Run history deleted.");
    } catch {
      setNotice("Run history could not be deleted.");
    }
  };
  const clear = async () => {
    try { const deletedCount = await clearRunHistory(); setRuns([]); setSelectedId(undefined); setNotice(`${deletedCount} run histories deleted.`); }
    catch { setNotice("Run history could not be deleted."); }
  };

  return <section className="run-history-page" aria-labelledby="run-history-title">
    <div className="section-heading"><div><p className="app-page__eyebrow">Audit trail</p><h1 id="run-history-title">Run history</h1></div><button onClick={() => setPendingConfirmation({ type: "all" })} disabled={!runs.length} aria-label="Delete all history">Delete all</button></div>
    {notice ? <p role="status">{notice}</p> : null}
    {runs.length === 0 ? <p>No runs recorded.</p> : <ul className="run-history" aria-label="Run history">
      {runs.map((run) => <li key={run.runId} className="history-card">
        <button className="history-card__open" onClick={() => setSelectedId((current) => current === run.runId ? undefined : run.runId)} aria-label={`View details for ${run.flowName}`}>
          <strong>{run.flowName}</strong>
          <span>Executed: {formatHistoryDateTime(run.startedAt)}</span>
          <span>Status: {formatRunStatus(run.status)}</span>
        </button>
        <button className="history-card__delete" onClick={() => setPendingConfirmation({ type: "run", run })} disabled={!canDelete(run)} aria-label={`Delete ${run.flowName}`}>Delete</button>
        {selectedId === run.runId ? <RunDetail run={run} /> : null}
      </li>)}
    </ul>}
    {pendingConfirmation ? <ConfirmDialog title={pendingConfirmation.type === "all" ? "실행이력 전체 삭제" : "실행이력 삭제"} description={pendingConfirmation.type === "all" ? "모든 실행이력을 삭제할까요? 이 작업은 되돌릴 수 없습니다." : `“${pendingConfirmation.run.flowName}” 실행이력을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`} confirmLabel={pendingConfirmation.type === "all" ? "전체 삭제" : "삭제"} onCancel={() => setPendingConfirmation(undefined)} onConfirm={() => { const confirmation = pendingConfirmation; setPendingConfirmation(undefined); if (confirmation.type === "all") void clear(); else void remove(confirmation.run); }} /> : null}
  </section>;
}
