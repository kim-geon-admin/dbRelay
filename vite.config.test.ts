import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

it("keeps native database modules out of the Electron main bundle", () => {
  expect(config).toMatch(/external:\s*\[\s*"better-sqlite3",\s*"oracledb",?\s*\]/u);
});
