import { contextBridge, ipcRenderer } from "electron";

const dbRelayCommands = [
  "list_connections",
  "save_connection",
  "update_connection",
  "disable_connection",
  "test_connection",
  "list_flows",
  "save_flow",
  "duplicate_flow",
  "start_run",
  "recover_run",
  "list_run_history",
] as const;

export function isAllowedCommand(command: string): boolean {
  return (dbRelayCommands as readonly string[]).includes(command);
}

const dbRelay = {
  invoke(command: string, request?: unknown) {
    if (!isAllowedCommand(command)) {
      throw new Error(`Unsupported DB Relay command: ${command}`);
    }

    return ipcRenderer.invoke("db-relay:invoke", command, request);
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("dbRelay", dbRelay);
}
