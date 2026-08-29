import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { listConnections } from "../connections/connections.api";
import type { Connection } from "../connections/connections.types";
import { FlowEditor } from "./FlowEditor";
import { deleteFlow, duplicateFlow, exportFlow, importFlow, listFlows, saveFlow } from "./flows.api";
import { transactionPolicyLabel, type Flow } from "./flows.types";

export function FlowLibrary() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Flow | null | undefined>(undefined);
  const [pendingDeletion, setPendingDeletion] = useState<Flow>();
  const [notice, setNotice] = useState<string>();
  const [nameFilter, setNameFilter] = useState("");
  const refresh = async () => { const [nextFlows, nextConnections] = await Promise.all([listFlows(), listConnections()]); setFlows(nextFlows); setConnections(nextConnections); };
  useEffect(() => { void refresh().catch(() => setNotice("Flows could not be loaded.")); }, []);
  const save = async (flow: Flow) => {
    const isEditingSavedFlow = editing?.id === flow.id && flows.some((saved) => saved.id === flow.id);
    const saved = await saveFlow(flow);
    setFlows((current) => {
      const next = current.some((item) => item.id === saved.id)
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [...current, saved];
      return next.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    });
    if (isEditingSavedFlow) {
      setEditing(saved);
      setNotice(undefined);
      return;
    }
    setEditing(undefined);
    setNotice("Flow saved.");
  };
  const duplicate = async (flow: Flow) => { await duplicateFlow(flow.id); await refresh(); setEditing(undefined); setNotice("Flow duplicated."); };
  const exportSavedFlow = async (flow: Flow) => {
    try {
      const result = await exportFlow(flow.id);
      setNotice(result.exported ? "Flow exported." : "Flow export cancelled.");
    } catch {
      setNotice("Flow could not be exported.");
    }
  };
  const deleteSavedFlow = async (flow: Flow) => {
    try {
      await deleteFlow(flow.id);
      setFlows((current) => current.filter((item) => item.id !== flow.id));
      setEditing((current) => current?.id === flow.id ? undefined : current);
      setNotice("Flow deleted.");
    } catch {
      setNotice("Flow could not be deleted.");
    }
  };
  const importSavedFlow = async () => {
    try {
      const result = await importFlow();
      if (result.status === "cancelled") return;
      if (result.status === "needs_connection_selection") {
        setEditing(result.flow);
        setNotice("Choose the missing connections, then save the imported flow.");
        return;
      }
      await refresh();
      setEditing(undefined);
      setNotice("Flow imported.");
    } catch {
      setNotice("Flow could not be imported.");
    }
  };
  const filteredFlows = flows.filter((flow) => flow.name.toLocaleLowerCase().includes(nameFilter.trim().toLocaleLowerCase()));

  return (
    <section className="flow-settings" aria-labelledby="flow-library-title">
      <div className="section-heading"><div><p className="app-page__eyebrow">Query sequences</p><h1 id="flow-library-title">Flow library</h1></div><div className="section-heading__actions"><button onClick={() => void importSavedFlow()}>Import flow</button><button onClick={() => setEditing(null)}>New flow</button></div></div>
      {notice ? <p role="status">{notice}</p> : null}
      {editing === null ? <FlowEditor connections={connections} onSave={save} onCancel={() => setEditing(undefined)} /> : null}
      {editing !== undefined && editing !== null && !flows.some((flow) => flow.id === editing.id)
        ? <FlowEditor connections={connections} initialFlow={editing} onSave={save} onCancel={() => setEditing(undefined)} />
        : null}
      <div className="flow-list__filter"><input aria-label="Filter flows by name" placeholder="Search flow names" value={nameFilter} onChange={(event) => setNameFilter(event.target.value)} /></div>
      <ul className="flow-list" aria-label="Saved flows">
        {filteredFlows.map((flow) => <li key={flow.id} className="flow-card">
          <div className="flow-card__details">
            <strong>{flow.name}</strong>
            <div className="flow-card__meta">
              <p>{flow.querySteps.length} query step{flow.querySteps.length === 1 ? "" : "s"}</p>
              <span className="flow-card__policy">{transactionPolicyLabel(flow.transactionPolicy)}</span>
            </div>
          </div>
          <div className="editor-actions flow-card__actions"><button onClick={() => setEditing((current) => current?.id === flow.id ? undefined : flow)}>Edit</button><button onClick={() => void duplicate(flow)}>Duplicate</button><button onClick={() => void exportSavedFlow(flow)}>Export</button><button onClick={() => setPendingDeletion(flow)}>Delete</button></div>
          {editing?.id === flow.id ? <FlowEditor connections={connections} initialFlow={flow} onSave={save} onCancel={() => setEditing(undefined)} /> : null}
        </li>)}
      </ul>
      {pendingDeletion ? <ConfirmDialog title="쿼리 시퀀스 삭제" description={`“${pendingDeletion.name}” 쿼리 시퀀스를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`} confirmLabel="삭제" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { const flow = pendingDeletion; setPendingDeletion(undefined); void deleteSavedFlow(flow); }} /> : null}
    </section>
  );
}
