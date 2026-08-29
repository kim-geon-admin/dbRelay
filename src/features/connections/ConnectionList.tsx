import { useEffect, useState } from "react";
import { ConnectionForm } from "./ConnectionForm";
import {
  deleteConnection,
  listConnections,
  saveConnection,
  setConnectionEnabled,
  testConnection,
} from "./connections.api";
import type { Connection, ConnectionSaveInput } from "./connections.types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { formatConnectorError } from "../../lib/oracleErrors";

function connectionTestErrorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && "detail" in error
    && typeof error.code === "string" && typeof error.detail === "string") {
    return formatConnectorError(error.code, error.detail);
  }
  return "CONNECTION_ERROR: A safe connection error detail is unavailable.";
}

export function ConnectionList() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Connection | null | undefined>(undefined);
  const [pendingDeletion, setPendingDeletion] = useState<Connection>();
  const [notice, setNotice] = useState<string>();
  const [connectionTestError, setConnectionTestError] = useState<string>();

  const refresh = async () => setConnections(await listConnections());

  useEffect(() => {
    void refresh().catch(() => setNotice("Connections could not be loaded."));
  }, []);

  const save = async (input: ConnectionSaveInput) => {
    await saveConnection(input);
    await refresh();
    setEditing(undefined);
    setNotice("Connection saved.");
  };

  const test = async (connection: Connection) => {
    try {
      await testConnection(connection.id);
      setConnectionTestError(undefined);
      setNotice(`${connection.displayName} connected successfully.`);
    } catch (error) {
      setNotice(`${connection.displayName} could not be connected.`);
      setConnectionTestError(connectionTestErrorDetail(error));
    }
  };

  const setEnabled = async (connection: Connection, enabled: boolean) => {
    const successNotice = `${connection.displayName} ${enabled ? "enabled" : "disabled"}.`;
    const refreshFailedNotice = `${connection.displayName} ${enabled ? "enabled" : "disabled"}, but the list could not be refreshed.`;

    try {
      const updatedConnection = await setConnectionEnabled(connection.id, enabled);
      setConnections((currentConnections) =>
        currentConnections.map((currentConnection) =>
          currentConnection.id === updatedConnection.id ? updatedConnection : currentConnection,
        ),
      );
    } catch {
      setNotice("Connection availability could not be updated.");
      return;
    }

    try {
      await refresh();
      setNotice(successNotice);
    } catch {
      setNotice(refreshFailedNotice);
    }
  };

  const remove = async (connection: Connection) => {
    try {
      await deleteConnection(connection.id);
      setConnections((currentConnections) =>
        currentConnections.filter((currentConnection) => currentConnection.id !== connection.id),
      );
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

      if (code === "CONNECTION_REFERENCED") {
        setNotice("flow에서 사용중이라 삭제할 수 없습니다.");
        return;
      }

      setNotice(`${connection.displayName} could not be deleted.`);
      return;
    }

    try {
      await refresh();
      setNotice(`${connection.displayName} deleted.`);
    } catch {
      setNotice(`${connection.displayName} deleted, but the list could not be refreshed.`);
    }
  };

  return (
    <section className="connection-settings" aria-labelledby="connection-settings-title">
      <div className="section-heading">
        <div>
          <p className="app-page__eyebrow">Database settings</p>
          <h1 id="connection-settings-title">Connections</h1>
        </div>
        <button onClick={() => setEditing(null)}>New connection</button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {connectionTestError ? <p role="alert">{connectionTestError}</p> : null}
      {editing === null ? (
        <ConnectionForm
          connection={editing ?? undefined}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      <ul className="connection-list">
        {connections.map((connection) => (
          <li key={connection.id} className="connection-card">
            <div className="connection-card__details">
              <strong>{connection.displayName}</strong>
              <p>
                {connection.kind.toUpperCase()} · {connection.host}:{connection.port}/{connection.sid}
              </p>
            </div>
            <span className="connection-card__status">{connection.enabled ? "Enabled" : "Disabled"}</span>
            <div className="editor-actions connection-card__actions">
              <button className="connection-card__action" onClick={() => setEditing((current) => current?.id === connection.id ? undefined : connection)}>
                Edit
              </button>
              <button
                className="connection-card__action"
                onClick={() => void test(connection)}
                disabled={!connection.enabled}
              >
                Test
              </button>
              <button
                className="connection-card__action connection-card__action--warning"
                onClick={() => void setEnabled(connection, !connection.enabled)}
              >
                {connection.enabled ? "Disable" : "Enable"}
              </button>
              <button className="connection-card__action" onClick={() => setPendingDeletion(connection)}>
                Delete
              </button>
            </div>
            {editing?.id === connection.id ? (
              <ConnectionForm
                connection={connection}
                onSave={save}
                onCancel={() => setEditing(undefined)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {pendingDeletion ? <ConfirmDialog title="DB 설정 삭제" description={`“${pendingDeletion.displayName}” DB 설정을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`} confirmLabel="삭제" onCancel={() => setPendingDeletion(undefined)} onConfirm={() => { const connection = pendingDeletion; setPendingDeletion(undefined); void remove(connection); }} /> : null}
    </section>
  );
}
