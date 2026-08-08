import { describe, expect, it } from "vitest";
import { isAllowedCommand } from "./preload";

describe("isAllowedCommand", () => {
  it("accepts only DB Relay command names", () => {
    expect(isAllowedCommand("list_connections")).toBe(true);
    expect(isAllowedCommand("execute_arbitrary_sql")).toBe(false);
  });
});
