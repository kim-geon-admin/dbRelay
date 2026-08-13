import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DB_RELAY_COMMANDS } from "./commands";

const workspace = resolve(import.meta.dirname, "../..");

describe("Electron process boundaries", () => {
  it("keeps release verification evidence out of the active-runtime scan", () => {
    const activeSources = repositoryFiles(workspace);

    expect(activeSources).not.toContain(
      resolve(workspace, "docs/test/reports/2026-08-08-react-electron-migration.md"),
    );
    expect(activeSources).toContain(resolve(workspace, "package.json"));
    expect(activeSources).toContain(resolve(workspace, "electron/main.ts"));
    expect(activeSources).toContain(resolve(workspace, "docs/product-specs/db-relay.md"));
  });

  it("contains no active retired-runtime references", () => {
    const obsoleteRuntimeName = ["tau", "ri"].join("");
    const activeSources = repositoryFiles(workspace);

    expect(existsSync(resolve(workspace, ["src", obsoleteRuntimeName].join("-")))).toBe(false);
    expect(activeSources.flatMap((file) => {
      const relative = file.slice(workspace.length + 1).replace(/\\/gu, "/");
      const matches = [];
      if (relative.toLowerCase().includes(obsoleteRuntimeName)) matches.push("path");
      if (readFileSync(file, "utf8").toLowerCase().includes(obsoleteRuntimeName)) {
        matches.push("content");
      }
      return matches.map((match) => ({ file: relative, match }));
    })).toEqual([]);
  });

  it("keeps database, Electron-main, and Node imports out of the renderer", () => {
    const renderer = productionFiles(resolve(workspace, "src"));
    const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

    expect(renderer.flatMap((file) => moduleSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => isForbiddenRendererImport(specifier, nodeBuiltins))
      .map((specifier) => ({ file, specifier })))).toEqual([]);
  });

  it("does not expose a generic SQL command", () => {
    expect(DB_RELAY_COMMANDS).toEqual([
      "list_connections",
      "save_connection",
      "update_connection",
      "disable_connection",
      "test_connection",
      "set_connection_enabled",
      "delete_connection",
      "list_flows",
      "save_flow",
      "duplicate_flow",
      "preview_flow_step",
      "run_flow_step",
      "start_run",
      "recover_run",
      "list_run_history",
    ]);
    expect(DB_RELAY_COMMANDS.some((command) => /arbitrary|generic|execute.*sql/iu.test(command)))
      .toBe(false);
  });

  it("limits source rows to the dedicated preview DTO and projection", () => {
    const commands = readFileSync(resolve(workspace, "electron/ipc/commands.ts"), "utf8");
    const handlers = readFileSync(resolve(workspace, "electron/ipc/handlers.ts"), "utf8");
    const desktop = readFileSync(resolve(workspace, "src/lib/desktop.ts"), "utf8");

    expect(commands).toMatch(/export type PreviewFlowStepDto = \{[\s\S]*?rows:/u);
    expect(commands).toMatch(/preview_flow_step: PreviewFlowStepDto/u);
    expect(commands).toMatch(/run_flow_step:\s*\{\s*affectedRows: number\s*\}/u);
    const runDto = /export type RunDto = \{(?<body>[\s\S]*?)\n\};/u.exec(commands)?.groups?.body ?? "";
    const historyRunDto = /export type HistoryRunDto = RunDto & \{(?<body>[\s\S]*?)\n\};/u.exec(commands)?.groups?.body ?? "";
    expect(runDto).not.toMatch(/rows|binds|password|credential|selectSql|upsertSql/iu);
    expect(historyRunDto).not.toMatch(/rows|binds|password|credential|selectSql|upsertSql/iu);
    expect(handlers).toMatch(/case "preview_flow_step":[\s\S]*projectPreview/u);
    expect(handlers).toMatch(/case "run_flow_step":[\s\S]*affectedRows/u);
    expect(desktop).toMatch(/type PreviewFlowStepDto = \{[\s\S]*?rows:/u);
    expect(desktop).toMatch(/preview_flow_step: PreviewFlowStepDto/u);
    expect(desktop).toMatch(/run_flow_step:\s*\{\s*affectedRows: number\s*\}/u);
  });

  it("limits renderer connection responses to passwordMask", () => {
    const facade = readFileSync(resolve(workspace, "src/lib/desktop.ts"), "utf8");
    const connectionProjection = /type ConnectionDto = \{(?<body>[\s\S]*?)\n\};/u.exec(facade)
      ?.groups?.body ?? "";

    expect(connectionProjection).toContain("passwordMask: string");
    expect(connectionProjection).not.toMatch(/plaintext|credentialRef|\bsecret\b/iu);
  });

  it("documents the preview-only source-row exception", () => {
    const agents = readFileSync(resolve(workspace, "AGENTS.md"), "utf8");
    const architecture = readFileSync(resolve(workspace, "ARCHITECTURE.md"), "utf8");
    for (const document of [agents, architecture]) {
      expect(document).toMatch(/preview_flow_step[^\n]*sole transient source-row exception/iu);
      expect(document).toMatch(/source rows never enter logs, SQLite, history, or other DTOs/iu);
      expect(document).toMatch(/closing preview clears renderer state/iu);
      expect(document).toMatch(/generic SQL/iu);
      expect(document).toMatch(/passwords|credentials/iu);
      expect(document).toMatch(/target bind value/iu);
    }
  });
});

function repositoryFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return isExcludedPath(path) ? [] : repositoryFiles(path);
    }
    return statSync(path).isFile()
      && (entry.name === ".gitignore" || /\.(?:json|md|rs|toml|ts|tsx|yaml|yml)$/u.test(path))
      ? [path]
      : [];
  });
}

function isExcludedPath(path: string): boolean {
  const relative = path.slice(workspace.length + 1).replace(/\\/gu, "/");
  const excludedRoots = [
    ".git",
    ".superpowers",
    "dist",
    "dist-electron",
    "node_modules",
    "release",
    "docs/superpowers",
    "docs/exec-plans/completed",
    "docs/test/reports",
  ];
  return excludedRoots.some((root) => relative === root || relative.startsWith(`${root}/`));
}

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return productionFiles(path);
    }
    return statSync(path).isFile() && /\.(?:ts|tsx)$/u.test(path) && !/\.test\.[^.]+$/u.test(path)
      ? [path]
      : [];
  });
}

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\()\s*["'](?<specifier>[^"']+)["']/gu)]
    .map((match) => match.groups?.specifier ?? "");
}

function isForbiddenRendererImport(
  specifier: string,
  nodeBuiltins: ReadonlySet<string>,
): boolean {
  const normalized = specifier.replace(/^node:/u, "");
  const packageRoot = normalized.split("/")[0];
  return normalized === "oracledb"
    || normalized === "better-sqlite3"
    || normalized === "electron"
    || normalized.startsWith("electron/")
    || nodeBuiltins.has(normalized)
    || nodeBuiltins.has(packageRoot);
}
