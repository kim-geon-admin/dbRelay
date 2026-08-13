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

export function ConnectionList() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Connection | null | undefined>(undefined);
  const [notice, setNotice] = useState<string>();

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
      setNotice(`${connection.displayName} connected successfully.`);
    } catch {
      setNotice(`${connection.displayName} could not be connected.`);
    }
  };

  const setEnabled = async (connection: Connection, enabled: boolean) => {
    try {
      await setConnectionEnabled(connection.id, enabled);
      await refresh();
      setNotice(`${connection.displayName} ${enabled ? "enabled" : "disabled"}.`);
    } catch {
      setNotice("Connection availability could not be updated.");
    }
  };

  const remove = async (connection: Connection) => {
    if (!window.confirm(`Delete ${connection.displayName}? This cannot be undone.`)) {
      return;
    }

    try {
      await deleteConnection(connection.id);
      await refresh();
      setNotice(`${connection.displayName} deleted.`);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

      if (code === "CONNECTION_REFERENCED") {
        setNotice("This connection is used by a flow and cannot be deleted.");
        return;
      }

      setNotice(`${connection.displayName} could not be deleted.`);
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
      {editing !== undefined ? (
        <ConnectionForm
          connection={editing ?? undefined}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      <ul className="connection-list">
        {connections.map((connection) => (
          <li key={connection.id} className="connection-card">
            <div>
              <strong>{connection.displayName}</strong>
              <p>
                {connection.kind.toUpperCase()} · {connection.host}:{connection.port}/{connection.sid}
              </p>
            </div>
            <span>{connection.enabled ? "Enabled" : "Disabled"}</span>
            <div className="editor-actions">
              <button className="connection-card__action" onClick={() => setEditing(connection)}>
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
              <button className="connection-card__action" onClick={() => void remove(connection)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
