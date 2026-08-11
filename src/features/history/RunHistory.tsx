import { useEffect, useState } from "react";
import { listRunHistory } from "./history.api";
import { RunDetail } from "./RunDetail";
import type { HistoryRun } from "./history.types";

export function RunHistory() {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => { void listRunHistory().then((items) => { setRuns(items); setSelectedId(items[0]?.runId); }).catch(() => setNotice("Run history could not be loaded.")); }, []);
  const selected = runs.find((run) => run.runId === selectedId);
  return <section className="run-history-page" aria-labelledby="run-history-title"><div className="section-heading"><div><p className="app-page__eyebrow">Audit trail</p><h1 id="run-history-title">Run history</h1></div></div>{notice ? <p role="status">{notice}</p> : null}<div className="run-history"><aside aria-label="Previous runs">{runs.map((run) => <button key={run.runId} onClick={() => setSelectedId(run.runId)}>{run.runId}</button>)}</aside>{selected ? <RunDetail run={selected} /> : <p>No runs recorded.</p>}</div></section>;
}
