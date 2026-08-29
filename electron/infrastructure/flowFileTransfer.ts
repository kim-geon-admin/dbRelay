import { readFile, writeFile } from "node:fs/promises";

import { dialog } from "electron";

import type { FlowFileTransfer, FlowTransferFile } from "../application/flowTransferService";

type SaveDialogResult = { canceled: boolean; filePath?: string };
type OpenDialogResult = { canceled: boolean; filePaths: string[] };

export interface FlowFileDialogs {
  showSaveDialog(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<SaveDialogResult>;
  showOpenDialog(options: { title: string; properties: ["openFile"]; filters: Array<{ name: string; extensions: string[] }> }): Promise<OpenDialogResult>;
}

export interface FlowFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
}

const fileFilter = [{ name: "DB Relay flow", extensions: ["json"] }];

export class ElectronFlowFileTransfer implements FlowFileTransfer {
  constructor(
    private readonly dialogs: FlowFileDialogs = dialog,
    private readonly files: FlowFileSystem = { readFile, writeFile },
  ) {}

  async save(file: FlowTransferFile): Promise<boolean> {
    const result = await this.dialogs.showSaveDialog({
      title: "Export flow",
      defaultPath: `${safeFileName(file.flow.name)}.dbrelay-flow.json`,
      filters: fileFilter,
    });
    if (result.canceled || result.filePath === undefined) return false;
    await this.files.writeFile(result.filePath, JSON.stringify(file, null, 2), "utf8");
    return true;
  }

  async open(): Promise<unknown | undefined> {
    const result = await this.dialogs.showOpenDialog({
      title: "Import flow",
      properties: ["openFile"],
      filters: fileFilter,
    });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    try {
      return JSON.parse(await this.files.readFile(result.filePaths[0], "utf8"));
    } catch {
      return null;
    }
  }
}

function safeFileName(name: string): string {
  const value = name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-");
  return value.length > 0 ? value : "flow";
}
