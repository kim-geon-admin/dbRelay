import { useEffect, useRef, useState } from "react";
import type { QueryStep } from "../flows/flows.types";
import { failedStep, recoveryFailure, type Run } from "./run.types";

type Props = {
  run: Run;
  step?: QueryStep;
  onEditRetry: (sql: Pick<QueryStep, "selectSql" | "upsertSql">) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
};

export function RecoveryDialog({ run, step, onEditRetry, onSkip, onStop }: Props) {
  const failed = failedStep(run);
  if (failed === undefined || run.policy !== "commit_successes") return null;
  return <RecoveryDialogContent key={`${run.runId}-${failed}`} run={run} step={step} failed={failed} onEditRetry={onEditRetry} onSkip={onSkip} onStop={onStop} />;
}

function RecoveryDialogContent({ run, step, failed, onEditRetry, onSkip, onStop }: Props & { failed: number }) {
  const [mode, setMode] = useState<"choices" | "edit" | "skip" | "stop">("choices");
  const [selectSql, setSelectSql] = useState(step?.selectSql ?? "");
  const [upsertSql, setUpsertSql] = useState(step?.upsertSql ?? "");
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);
  useEffect(() => {
    const firstControl = dialogRef.current?.querySelector<HTMLElement>("button:not([disabled]), textarea:not([disabled])");
    firstControl?.focus();
  }, [mode]);
  const failure = recoveryFailure(run, failed);
  const committed = run.steps.slice(0, failed).filter((item) => typeof item === "object" && "succeeded" in item).length;
  const submitRetry = () => { if (selectSql.trim() && upsertSql.trim()) void onEditRetry({ selectSql: selectSql.trim(), upsertSql: upsertSql.trim() }); };
  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), textarea:not([disabled])") ?? []);
    if (!focusable.length) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const direction = event.shiftKey ? -1 : 1;
    const next = focusable[(current + direction + focusable.length) % focusable.length];
    event.preventDefault();
    next.focus();
  };

  return <div className="recovery-backdrop" role="presentation"><section ref={dialogRef} className="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title" onKeyDown={trapFocus}>
    <h2 id="recovery-title">Recovery required</h2>
    <p>Step {failed + 1} failed after {committed} committed step{committed === 1 ? "" : "s"}.</p>
    {failure ? <p><strong>{failure.code}</strong>: {failure.message}</p> : null}
    {mode === "choices" ? <div className="editor-actions"><button onClick={() => setMode("edit")}>Edit and retry</button><button onClick={() => setMode("skip")}>Skip and continue</button><button onClick={() => setMode("stop")}>Stop</button></div> : null}
    {mode === "edit" ? <div className="editor-form"><label>Source SQL<textarea className="sql-editor" value={selectSql} onChange={(event) => setSelectSql(event.target.value)} /></label><label>Target SQL<textarea className="sql-editor" value={upsertSql} onChange={(event) => setUpsertSql(event.target.value)} /></label>{!selectSql.trim() || !upsertSql.trim() ? <p role="alert">Both SQL statements are required.</p> : null}<div className="editor-actions"><button onClick={submitRetry} disabled={!selectSql.trim() || !upsertSql.trim()}>Retry step</button><button onClick={() => setMode("choices")}>Back</button></div></div> : null}
    {mode === "skip" ? <div><p role="alert">Skipping leaves this step&apos;s data unprocessed.</p><div className="editor-actions"><button onClick={() => void onSkip()}>Confirm skip and continue</button><button onClick={() => setMode("choices")}>Back</button></div></div> : null}
    {mode === "stop" ? <div><p role="alert">Stopping leaves prior committed results in place.</p><div className="editor-actions"><button onClick={() => void onStop()}>Confirm stop</button><button onClick={() => setMode("choices")}>Back</button></div></div> : null}
  </section></div>;
}
