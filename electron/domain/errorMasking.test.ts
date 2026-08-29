import { describe, expect, it } from "vitest";
import { maskSensitiveText } from "./errorMasking";

describe("sensitive error masking", () => {
  it("masks named passwords and connection-string credentials", () => {
    const masked = maskSensitiveText(
      "connection failed: User Id=scott;Password='top secret';Token=abc123",
    );

    expect(masked).toBe(
      "connection failed: User Id=[REDACTED];Password=[REDACTED];Token=[REDACTED]",
    );
  });

  it("masks an entire quoted password containing doubled quote escapes", () => {
    expect(maskSensitiveText("Password='top''secret';Host=db"))
      .toBe("Password=[REDACTED];Host=db");
  });

  it("masks supplied credential values without case sensitivity", () => {
    const masked = maskSensitiveText(
      "connection failed for SCOTT with top-secret and ABC123",
      ["scott", "top-secret", "abc123"],
    );

    expect(masked).toBe(
      "connection failed for [REDACTED] with [REDACTED] and [REDACTED]",
    );
  });

  it("masks overlapping supplied credentials longest first", () => {
    const masked = maskSensitiveText("connection failed for admin123", ["admin", "admin123"]);

    expect(masked).toBe("connection failed for [REDACTED]");
    expect(masked).not.toContain("123");
  });

  it("ignores empty supplied values", () => {
    expect(maskSensitiveText("connection failed", [""])).toBe("connection failed");
  });

  it("does not mask sensitive words that are not key-value pairs", () => {
    expect(maskSensitiveText("password policy rejected the token format"))
      .toBe("password policy rejected the token format");
  });
});
