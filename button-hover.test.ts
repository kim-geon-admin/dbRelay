import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

describe("global button hover treatment", () => {
  it("gives every enabled native button a lifted hover state", () => {
    expect(styles).toMatch(/button:hover:not\(:disabled\)\s*\{[\s\S]*?border-color:[\s\S]*?box-shadow:[\s\S]*?transform:\s*translateY\(-1px\)/);
  });
});
