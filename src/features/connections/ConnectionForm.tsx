import { useEffect, useState } from "react";
import type { Connection, ConnectionSaveInput, DbKind } from "./connections.types";

type ConnectionFormProps = {
  connection?: Connection;
  onSave: (input: ConnectionSaveInput) => void | Promise<void>;
  onCancel?: () => void;
};

type FormState = {
  displayName: string;
  kind: DbKind;
  host: string;
  port: string;
  sid: string;
  username: string;
  password: string;
};
type TextField = keyof FormState;

function blankForm(): FormState {
  return { displayName: "", kind: "oracle", host: "", port: "1521", sid: "", username: "", password: "" };
}

function formFor(connection?: Connection): FormState {
  if (!connection) return blankForm();
  return {
    displayName: connection.displayName,
    kind: connection.kind,
    host: connection.host,
    port: String(connection.port),
    sid: connection.sid,
    username: connection.username,
    password: connection.passwordMask,
  };
}

function connectionId() {
  return globalThis.crypto?.randomUUID?.() ?? `connection-${Date.now()}`;
}

export function ConnectionForm({ connection, onSave, onCancel }: ConnectionFormProps) {
  const [values, setValues] = useState<FormState>(() => formFor(connection));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  useEffect(() => {
    setValues(formFor(connection));
    setPasswordChanged(false);
  }, [connection]);

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setError(undefined);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const required: Array<[TextField, string]> = [
      ["displayName", "Display name"], ["host", "Host"], ["sid", "SID"], ["username", "Username"],
    ];
    const missing = required.find(([field]) => !values[field].trim());
    if (missing) return setError(`${missing[1]} is required.`);
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError("Port must be between 1 and 65535.");
    if (!connection && !values.password) return setError("Password is required for a new connection.");

    setSaving(true);
    try {
      await onSave({
        id: connection?.id ?? connectionId(),
        displayName: values.displayName.trim(), kind: values.kind, host: values.host.trim(), port,
        sid: values.sid.trim(), username: values.username.trim(),
        ...(connection ? { enabled: connection.enabled } : {}),
        ...((!connection || passwordChanged) && values.password ? { password: values.password } : {}),
      });
      if (!connection || passwordChanged) setValues((current) => ({ ...current, password: "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="editor-form" onSubmit={submit} noValidate>
      <h2>{connection ? "Edit connection" : "New connection"}</h2>
      <label>Display name<input aria-label="Display name" value={values.displayName} onChange={(event) => update("displayName", event.target.value)} /></label>
      <label>Database kind<select aria-label="Database kind" value={values.kind} onChange={(event) => update("kind", event.target.value as DbKind)}><option value="oracle">Oracle</option></select></label>
      <label>Host<input aria-label="Host" value={values.host} onChange={(event) => update("host", event.target.value)} /></label>
      <label>Port<input aria-label="Port" inputMode="numeric" value={values.port} onChange={(event) => update("port", event.target.value)} /></label>
      <label>SID<input aria-label="SID" value={values.sid} onChange={(event) => update("sid", event.target.value)} /></label>
      <label>Username<input aria-label="Username" value={values.username} onChange={(event) => update("username", event.target.value)} /></label>
      <label>Password<input aria-label="Password" type="text" autoComplete="new-password" value={values.password} onFocus={(event) => {
        if (connection && !passwordChanged) {
          const caret = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(caret, caret);
        }
      }} onChange={(event) => {
        setPasswordChanged(true);
        update("password", event.target.value);
      }} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="editor-actions">
        {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save connection"}</button>
      </div>
    </form>
  );
}
