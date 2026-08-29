import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");
const runHistory = readFileSync(resolve(process.cwd(), "src/features/history/RunHistory.tsx"), "utf8");

describe("right-panel content density", () => {
  it("matches forms, cards, and run panels to the compact sidebar type scale", () => {
    expect(styles).toMatch(/\.editor-form,[\s\S]*?\.run-history > aside\s*\{[\s\S]*?font-size:\s*0\.8125rem;/);
  });

  it("uses compact flow controls instead of the former 40px controls", () => {
    expect(styles).toMatch(/\.flow-editor input,[\s\S]*?\.flow-editor button\s*\{[\s\S]*?min-height:\s*30px;[\s\S]*?padding:\s*6px 8px;/);
  });

  it("applies the compact scale to every right-side screen", () => {
    expect(styles).toMatch(/\.connection-settings,[\s\S]*?\.run-history-page,[\s\S]*?font-size:\s*0\.8125rem;/);
    expect(runHistory).toContain('className="run-history-page"');
  });
});
