import {
  app,
  BrowserWindow,
  ipcMain,
  type Event as ElectronEvent,
  type WebContents,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FlowService } from "./application/flowService";
import { HistoryService } from "./application/historyService";
import { MigrationRunner } from "./application/migrationRunner";
import { SettingsService } from "./application/settingsService";
import { OracleConnector } from "./connectors/oracleConnector";
import { ConnectorRegistry } from "./connectors/registry";
import { SqliteRepository } from "./infrastructure/sqliteRepository";
import {
  isAllowedRendererUrl,
  isTrustedIpcSender,
  registerDbRelayIpc,
} from "./ipc/handlers";

let repository: SqliteRepository | undefined;
const trustedRenderers = new Set<WebContents>();

function createWindow(approvedUrl: string) {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.js"),
    },
  });
  const webContents = window.webContents;
  trustedRenderers.add(webContents);
  window.on("closed", () => trustedRenderers.delete(webContents));
  const preventUntrustedNavigation = (event: ElectronEvent, url: string) => {
    if (!isAllowedRendererUrl(url, approvedUrl)) {
      event.preventDefault();
    }
  };
  webContents.on("will-navigate", preventUntrustedNavigation);
  webContents.on("will-redirect", preventUntrustedNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(approvedUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  const approvedUrl = process.env.VITE_DEV_SERVER_URL
    ? process.env.VITE_DEV_SERVER_URL
    : pathToFileURL(join(__dirname, "../dist/index.html")).href;
  repository = SqliteRepository.open(join(app.getPath("userData"), "db-relay.sqlite"));
  const connector = new OracleConnector();
  registerDbRelayIpc(ipcMain, {
    settings: new SettingsService(repository),
    flows: new FlowService(repository),
    runs: new MigrationRunner(connector, repository, repository),
    history: new HistoryService(repository),
    connectors: new ConnectorRegistry([connector]),
  }, (event) => isTrustedIpcSender(event, trustedRenderers, approvedUrl));
  createWindow(approvedUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(approvedUrl);
  });
});

app.on("before-quit", () => {
  repository?.close();
  repository = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
