import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

it("keeps preview headers above vertical scrolling and row numbers at the left edge", () => {
  expect(styles).toMatch(/\.step-preview-dialog thead th\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/);
  expect(styles).toMatch(/\.step-preview-dialog tbody \.step-preview-dialog__line-number\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?left:\s*0;/);
  expect(styles).toMatch(/\.step-preview-dialog thead \.step-preview-dialog__line-number\s*\{[\s\S]*?left:\s*0;/);
});
