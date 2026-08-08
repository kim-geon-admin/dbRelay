import { useEffect, useState } from "react";
import { ConnectionForm } from "./ConnectionForm";
import { disableConnection, listConnections, saveConnection, testConnection } from "./connections.api";
import type { Connection, ConnectionSaveInput } from "./connections.types";

export function ConnectionList() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Connection | null | undefined>(undefined);
  const [notice, setNotice] = useState<string>();

  const refresh = async () => setConnections(await listConnections());
  useEffect(() => { void refresh().catch(() => setNotice("Connections could not be loaded.")); }, []);

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

  const disable = async (connection: Connection) => {
    await disableConnection(connection.id);
    await refresh();
    setNotice(`${connection.displayName} disabled.`);
  };

  return (
    <section className="connection-settings" aria-labelledby="connection-settings-title">
      <div className="section-heading"><div><p className="app-page__eyebrow">Database settings</p><h1 id="connection-settings-title">Connections</h1></div><button onClick={() => setEditing(null)}>New connection</button></div>
      {notice ? <p role="status">{notice}</p> : null}
      {editing !== undefined ? <ConnectionForm connection={editing ?? undefined} onSave={save} onCancel={() => setEditing(undefined)} /> : null}
      <ul className="connection-list">
        {connections.map((connection) => <li key={connection.id} className="connection-card">
          <div><strong>{connection.displayName}</strong><p>{connection.kind.toUpperCase()} · {connection.host}:{connection.port}/{connection.sid}</p></div>
          <span>{connection.enabled ? "Enabled" : "Disabled"}</span>
          <div className="editor-actions"><button onClick={() => setEditing(connection)}>Edit</button><button onClick={() => void test(connection)} disabled={!connection.enabled}>Test</button>{connection.enabled ? <button onClick={() => void disable(connection)}>Disable</button> : null}</div>
        </li>)}
      </ul>
    </section>
  );
}
