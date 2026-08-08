import { useEffect, useState } from "react";
import { QueryStepEditor } from "./QueryStepEditor";
import type { Flow, FlowEditorProps, QueryStep, TransactionPolicy } from "./flows.types";

function nextId(prefix: string) { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}`; }
function newStep(): QueryStep { return { id: nextId("step"), operation: "insert", selectSql: "", upsertSql: "" }; }
function newFlow(): Flow { return { id: nextId("flow"), name: "", sourceConnectionId: "", targetConnectionId: "", querySteps: [newStep()], transactionPolicy: "all_or_nothing", version: 0 }; }

export function FlowEditor({ connections, initialFlow, onSave, onCancel }: FlowEditorProps) {
  const [flow, setFlow] = useState<Flow>(() => initialFlow ?? newFlow());
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setFlow(initialFlow ?? newFlow()), [initialFlow]);

  const updateStep = (index: number, step: QueryStep) => setFlow((current) => ({ ...current, querySteps: current.querySteps.map((item, itemIndex) => itemIndex === index ? step : item) }));
  const moveStep = (index: number, direction: -1 | 1) => setFlow((current) => {
    const destination = index + direction;
    if (destination < 0 || destination >= current.querySteps.length) return current;
    const steps = [...current.querySteps];
    [steps[index], steps[destination]] = [steps[destination], steps[index]];
    return { ...current, querySteps: steps };
  });

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!flow.name.trim()) return setError("Flow name is required.");
    if (!flow.sourceConnectionId || !flow.targetConnectionId) return setError("Choose both source and target connections.");
    if (flow.sourceConnectionId === flow.targetConnectionId) return setError("Source and target connections must be different.");
    if (!flow.querySteps.length) return setError("At least one query step is required.");
    if (flow.querySteps.some((step) => !step.selectSql.trim() || !step.upsertSql.trim())) return setError("Each query step needs source and target SQL.");
    setSaving(true);
    try { await onSave({ ...flow, name: flow.name.trim() }); setError(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Flow could not be saved."); }
    finally { setSaving(false); }
  };

  return <form className="editor-form flow-editor" onSubmit={submit} noValidate>
    <h2>{initialFlow ? "Edit flow" : "New flow"}</h2>
    <label>Flow name<input value={flow.name} onChange={(event) => setFlow({ ...flow, name: event.target.value })} /></label>
    <label>Source connection<select value={flow.sourceConnectionId} onChange={(event) => setFlow({ ...flow, sourceConnectionId: event.target.value })}><option value="">Choose source</option>{connections.filter((connection) => connection.enabled).map((connection) => <option value={connection.id} key={connection.id}>{connection.displayName}</option>)}</select></label>
    <label>Target connection<select value={flow.targetConnectionId} onChange={(event) => setFlow({ ...flow, targetConnectionId: event.target.value })}><option value="">Choose target</option>{connections.filter((connection) => connection.enabled).map((connection) => <option value={connection.id} key={connection.id}>{connection.displayName}</option>)}</select></label>
    <label>Transaction policy<select value={flow.transactionPolicy} onChange={(event) => setFlow({ ...flow, transactionPolicy: event.target.value as TransactionPolicy })}><option value="all_or_nothing">All or nothing</option><option value="commit_successes">Commit successes</option></select></label>
    <div className="section-heading"><h3>Query steps</h3><button type="button" onClick={() => setFlow((current) => ({ ...current, querySteps: [...current.querySteps, newStep()] }))}>Add step</button></div>
    {flow.querySteps.map((step, index) => <QueryStepEditor key={step.id} step={step} position={index} total={flow.querySteps.length} onChange={(next) => updateStep(index, next)} onMove={(direction) => moveStep(index, direction)} onDelete={() => setFlow((current) => ({ ...current, querySteps: current.querySteps.filter((_, itemIndex) => itemIndex !== index) }))} />)}
    {error ? <p role="alert">{error}</p> : null}
    <div className="editor-actions">
      {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
      <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save flow"}</button>
    </div>
  </form>;
}
