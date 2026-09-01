import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type Event as ElectronEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FlowService } from "./application/flowService";
import { FlowTransferService } from "./application/flowTransferService";
import { EditablePreviewCache } from "./application/editablePreviewCache";
import { HistoryService } from "./application/historyService";
import { MigrationRunner } from "./application/migrationRunner";
import { SettingsService } from "./application/settingsService";
import { OracleConnector } from "./connectors/oracleConnector";
import { ConnectorRegistry } from "./connectors/registry";
import { SqliteRepository } from "./infrastructure/sqliteRepository";
import { ElectronFlowFileTransfer } from "./infrastructure/flowFileTransfer";
import {
  isAllowedRendererUrl,
  isTrustedIpcSender,
  registerDbRelayIpc,
} from "./ipc/handlers";

let repository: SqliteRepository | undefined;
const trustedRenderers = new Set<WebContents>();
const USER_GUIDE_URL = "https://github.com/kim-geon-admin/dbRelay/blob/main/docs/user-guide.md";

function installApplicationMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [{ role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Manual", click: () => { void shell.openExternal(USER_GUIDE_URL); } },
        { label: "Close", role: "close" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(approvedUrl: string, devServerUrl: string | undefined) {
  const window = new BrowserWindow({
    icon: join(__dirname, "../assets/db-relay-icon.ico"),
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

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  installApplicationMenu();
  const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  const approvedUrl = devServerUrl
    ?? pathToFileURL(join(__dirname, "../dist/index.html")).href;
  repository = SqliteRepository.open(join(app.getPath("userData"), "db-relay.sqlite"));
  const connector = new OracleConnector();
  registerDbRelayIpc(ipcMain, {
    settings: new SettingsService(repository),
    flows: new FlowService(repository),
    flowTransfer: new FlowTransferService(repository, new ElectronFlowFileTransfer(), randomUUID),
    runs: new MigrationRunner(connector, repository, repository, undefined, new EditablePreviewCache()),
    history: new HistoryService(repository),
    connectors: new ConnectorRegistry([connector]),
  }, (event) => isTrustedIpcSender(event, trustedRenderers, approvedUrl));
  createWindow(approvedUrl, devServerUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(approvedUrl, devServerUrl);
  });
});

app.on("before-quit", () => {
  repository?.close();
  repository = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
