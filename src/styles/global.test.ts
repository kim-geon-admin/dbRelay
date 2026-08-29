import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

test("uses distinct amber restore colors for enabled and disabled actions", () => {
  expect(css).toMatch(/\.query-step__operation-actions \.query-step__action--restore\s*\{[\s\S]*?background: var\(--color-restore-active\)/u);
  expect(css).toMatch(/\.query-step__operation-actions \.query-step__action--restore:disabled\s*\{[\s\S]*?background: var\(--color-restore-disabled\)/u);
});
