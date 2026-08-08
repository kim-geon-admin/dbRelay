import { describe, expect, it } from "vitest";
import { extractNamedBinds, mapRow } from "./mapping";
import type { NamedRow } from "./models";

describe("Oracle named-bind mapping", () => {
  it("maps Oracle binds to source columns without case sensitivity", () => {
    const mapped: NamedRow = mapRow(
      { CUSTOMER_ID: 7, display_name: "Ada" },
      ["customer_id", "DISPLAY_NAME"],
    );

    expect(mapped).toEqual({ customer_id: 7, DISPLAY_NAME: "Ada" });
  });

  it("rejects a bind missing from the source row", () => {
    expect(() => mapRow({ CUSTOMER_ID: 7 }, ["DISPLAY_NAME"]))
      .toThrow("missing source column");
  });

  it("ignores bind-like text in quoted literals, identifiers, and comments", () => {
    expect(extractNamedBinds(
      "update t set note = ':NOT_A_BIND', \"quoted:identifier\" = :VALUE "
        + "-- :COMMENT\n/* :BLOCK_COMMENT */ where id = :ID",
    )).toEqual(["VALUE", "ID"]);
  });

  it("keeps only the first case-insensitive occurrence of each bind", () => {
    expect(extractNamedBinds(
      "update t set a = :ID, b = :name where id = :id and c = :NAME",
    )).toEqual(["ID", "name"]);
  });

  it("rejects duplicate case-insensitive source columns", () => {
    expect(() => mapRow({ id: 1, ID: 2 }, ["ID"]))
      .toThrow("duplicate source column: ID");
  });

  it("normalizes ASCII case without changing non-ASCII column names", () => {
    expect(mapRow({ "ß": 1, SS: 2 }, ["ß", "ss"]))
      .toEqual({ "ß": 1, ss: 2 });
  });

  it("rejects numeric bind placeholders", () => {
    expect(() => extractNamedBinds("update t set value = :1"))
      .toThrow("numeric bind placeholder is not supported: 1");
  });

  it("maps a __proto__ bind as an own key without changing the result prototype", () => {
    const row = Object.create(null) as NamedRow;
    row.__proto__ = 7;
    const binds = extractNamedBinds("UPDATE customer SET value = :__proto__");

    const mapped = mapRow(row, binds);

    expect(Object.prototype.hasOwnProperty.call(mapped, "__proto__")).toBe(true);
    expect(mapped.__proto__).toBe(7);
    expect(Object.getPrototypeOf(mapped)).toBeNull();
  });
});
