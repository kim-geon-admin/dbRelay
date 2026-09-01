import { expect, test } from "vitest";
import { EditablePreviewCache } from "./editablePreviewCache";

test("replaces preview rows and consumes them once", () => {
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

test("keeps rows whose columns are missing or extra so the run reports them", () => {
  // Would fail if saving edited preview rows validated the column set, which
  // blocks the save for values the target statement could still accept.
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID"], [{ ID: 1 }]);

  cache.save(previewId, ["ID"], [{ ID: 1, OTHER: "extra" }, {}]);

  expect(cache.consume(previewId)).toEqual({
    columns: ["ID"],
    rows: [{ ID: 1, OTHER: "extra" }, {}],
    unsupportedBindColumns: [],
  });
});

test("reports a missing preview with a code the boundary can surface", () => {
  const cache = new EditablePreviewCache();

  expect(() => cache.save("unknown", ["ID"], [{ ID: 1 }]))
    .toThrowError(expect.objectContaining({ code: "PREVIEW_NOT_FOUND" }));
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
