import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

it("keeps a compact sidebar instead of reflowing it above content", () => {
  expect(styles).toContain("grid-template-columns: 224px minmax(420px, 1fr);");
  expect(styles).toContain("min-width: 644px;");
  expect(styles).not.toContain(".app-shell {\n    display: block;");
});
