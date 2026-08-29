import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const navigationHandlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
  const webContents = {
    on: vi.fn((event: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
      navigationHandlers.set(event, handler);
    }),
    setWindowOpenHandler: vi.fn(),
  };
  const browserWindow = {
    webContents,
    on: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
  };
  const app = {
    isPackaged: true,
    whenReady: vi.fn().mockResolvedValue(undefined),
    getPath: vi.fn().mockReturnValue("C:/DB Relay user data"),
    on: vi.fn(),
    quit: vi.fn(),
  };
  const dialog = {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  };

  return { app, browserWindow, dialog, navigationHandlers, webContents };
});

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: Object.assign(vi.fn(function BrowserWindowMock() {
    return electron.browserWindow;
  }), {
    getAllWindows: vi.fn().mockReturnValue([electron.browserWindow]),
  }),
  ipcMain: { handle: vi.fn() },
  dialog: electron.dialog,
}));

vi.mock("./infrastructure/sqliteRepository", () => ({
  SqliteRepository: {
    open: vi.fn(() => ({ close: vi.fn() })),
  },
}));

describe("Electron renderer startup", () => {
  const originalDevServerUrl = process.env.VITE_DEV_SERVER_URL;

  beforeEach(() => {
    vi.resetModules();
    electron.app.isPackaged = true;
    electron.browserWindow.loadFile.mockClear();
    electron.browserWindow.loadURL.mockClear();
    electron.navigationHandlers.clear();
  });

  afterEach(() => {
    if (originalDevServerUrl === undefined) {
      delete process.env.VITE_DEV_SERVER_URL;
    } else {
      process.env.VITE_DEV_SERVER_URL = originalDevServerUrl;
    }
  });

  it("ignores VITE_DEV_SERVER_URL in a packaged app and loads only the local renderer", async () => {
    process.env.VITE_DEV_SERVER_URL = "https://attacker.example/renderer";

    await import("./main");
    await vi.waitFor(() => {
      expect(
        electron.browserWindow.loadFile.mock.calls.length
          + electron.browserWindow.loadURL.mock.calls.length,
      ).toBe(1);
    });

    expect(electron.browserWindow.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]dist[\\/]index\.html$/u),
    );
    expect(electron.browserWindow.loadURL).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    electron.navigationHandlers.get("will-navigate")?.(
      { preventDefault },
      "https://attacker.example/renderer",
    );
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
