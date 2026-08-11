import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

describe("flow SQL editor sizing", () => {
  it("uses a compact 2/3-height SQL editor in the flow editor", () => {
    expect(styles).toMatch(/\.flow-editor \.sql-editor\s*\{\s*min-height:\s*147px;/);
  });
});
