import { expect, test } from "vitest";
import { EditablePreviewCache } from "./editablePreviewCache";

test("replaces preview rows only when the exact column set matches and consumes them once", () => {
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID", "NAME"], [{ ID: 1, NAME: "Ada" }]);

  cache.save(previewId, ["ID", "NAME"], [{ ID: 1, NAME: "Lin" }]);

  expect(cache.consume(previewId)).toEqual({
    columns: ["ID", "NAME"],
    rows: [{ ID: 1, NAME: "Lin" }],
    unsupportedBindColumns: [],
  });
  expect(() => cache.consume(previewId)).toThrow(/preview/i);
});

test("rejects rows with missing or extra columns", () => {
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID"], [{ ID: 1 }]);

  expect(() => cache.save(previewId, ["ID"], [{ ID: 1, OTHER: "no" }])).toThrow(/column/i);
  expect(() => cache.save(previewId, ["ID"], [{}])).toThrow(/column/i);
});

test("copies byte values so later callers cannot mutate a saved preview", () => {
  const cache = new EditablePreviewCache();
  const bytes = new Uint8Array([1, 2, 3]);
  const previewId = cache.create(["PAYLOAD"], [{ PAYLOAD: bytes }]);
  bytes[0] = 9;

  const consumed = cache.consume(previewId);

  expect(Array.from(consumed.rows[0].PAYLOAD as Uint8Array)).toEqual([1, 2, 3]);
});

test("preserves unsupported bind-column metadata across a save", () => {
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID", "UNSUPPORTED"], [{ ID: 1, UNSUPPORTED: "value" }], ["UNSUPPORTED"]);

  cache.save(previewId, ["ID", "UNSUPPORTED"], [{ ID: 2, UNSUPPORTED: "value" }]);

  expect(cache.consume(previewId).unsupportedBindColumns).toEqual(["UNSUPPORTED"]);
});
