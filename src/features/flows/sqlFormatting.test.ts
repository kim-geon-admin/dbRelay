import { expect, test } from "vitest";
import { formatOracleSql } from "./sqlFormatting";

test("formats an Oracle SELECT without replacing named bind placeholders", () => {
  expect(formatOracleSql("select id,email from customers where id=:customer_id"))
    .toBe("SELECT\n  id,\n  email\nFROM\n  customers\nWHERE\n  id = :customer_id");
});
