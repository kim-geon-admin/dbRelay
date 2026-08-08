import { useEffect, useState } from "react";
import { listConnections } from "../connections/connections.api";
import type { Connection } from "../connections/connections.types";
import { FlowEditor } from "./FlowEditor";
import { duplicateFlow, listFlows, saveFlow } from "./flows.api";
import type { Flow } from "./flows.types";

export function FlowLibrary() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Flow | null | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const refresh = async () => { const [nextFlows, nextConnections] = await Promise.all([listFlows(), listConnections()]); setFlows(nextFlows); setConnections(nextConnections); };
  useEffect(() => { void refresh().catch(() => setNotice("Flows could not be loaded.")); }, []);
  const save = async (flow: Flow) => { await saveFlow(flow); await refresh(); setEditing(undefined); setNotice("Flow saved."); };
  const duplicate = async (flow: Flow) => { await duplicateFlow(flow.id); await refresh(); setEditing(undefined); setNotice("Flow duplicated."); };

  return (
    <section className="flow-settings" aria-labelledby="flow-library-title">
      <div className="section-heading"><div><p className="app-page__eyebrow">Query sequences</p><h1 id="flow-library-title">Flow library</h1></div><button onClick={() => setEditing(null)}>New flow</button></div>
      {notice ? <p role="status">{notice}</p> : null}
      {editing !== undefined ? <FlowEditor connections={connections} initialFlow={editing ?? undefined} onSave={save} onCancel={() => setEditing(undefined)} /> : null}
      <ul className="flow-list" aria-label="Saved flows">
        {flows.map((flow) => <li key={flow.id} className="flow-card">
          <div><strong>{flow.name}</strong><p>{flow.querySteps.length} query step{flow.querySteps.length === 1 ? "" : "s"}</p></div>
          <span>{flow.transactionPolicy === "all_or_nothing" ? "All or nothing" : "Commit successes"}</span>
          <div className="editor-actions"><button onClick={() => setEditing(flow)}>Edit</button><button onClick={() => void duplicate(flow)}>Duplicate</button></div>
        </li>)}
      </ul>
    </section>
  );
}
