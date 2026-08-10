import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

it("allows the three-column connection details row to shrink without overlap", () => {
  expect(styles).toContain(".connection-settings .connection-form__connection-details > label");
  expect(styles).toContain("min-width: 0;");
  expect(styles).toContain("width: 100%;");
});
