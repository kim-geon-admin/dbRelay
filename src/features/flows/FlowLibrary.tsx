import { useEffect, useState } from "react";
import { listConnections } from "../connections/connections.api";
import type { Connection } from "../connections/connections.types";
import { FlowEditor } from "./FlowEditor";
import { duplicateFlow, listFlows, saveFlow } from "./flows.api";
import type { Flow } from "./flows.types";

export function FlowLibrary() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<Flow>();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const refresh = async () => { const [nextFlows, nextConnections] = await Promise.all([listFlows(), listConnections()]); setFlows(nextFlows); setConnections(nextConnections); };
  useEffect(() => { void refresh().catch(() => setNotice("Flows could not be loaded.")); }, []);
  const save = async (flow: Flow) => { const saved = await saveFlow(flow); await refresh(); setSelected(saved); setCreating(false); setNotice("Flow saved."); };
  const duplicate = async (flow: Flow) => { const copy = await duplicateFlow(flow.id); await refresh(); setSelected(copy); setCreating(false); setNotice("Flow duplicated."); };
  return <section aria-labelledby="flow-library-title"><div className="section-heading"><div><p className="app-page__eyebrow">Query sequences</p><h1 id="flow-library-title">Flow library</h1></div><button onClick={() => { setCreating(true); setSelected(undefined); }}>New flow</button></div>{notice ? <p role="status">{notice}</p> : null}<div className="flow-library"><aside aria-label="Saved flows"><h2>Saved flows</h2>{flows.map((flow) => <div key={flow.id}><button onClick={() => { setSelected(flow); setCreating(false); }}>{flow.name}</button><button onClick={() => void duplicate(flow)} aria-label={`Duplicate ${flow.name}`}>Duplicate</button></div>)}</aside><div>{creating || selected ? <FlowEditor connections={connections} initialFlow={creating ? undefined : selected} onSave={save} /> : <p>Select a flow or create a new one.</p>}</div></div></section>;
}

