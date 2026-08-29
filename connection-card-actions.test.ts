import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

it("gives connection actions raised, disabled, and warning states", () => {
  expect(styles).toContain(".connection-card__action:hover:not(:disabled)");
  expect(styles).toContain(".connection-card__action:disabled");
  expect(styles).toContain(".connection-card__action--warning");
});
