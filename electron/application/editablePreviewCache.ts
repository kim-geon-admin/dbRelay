import { randomUUID } from "node:crypto";

import type { NamedRow, RowSet } from "../domain/models";

type CachedPreview = RowSet;

export class EditablePreviewCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditablePreviewCacheError";
  }
}

export class EditablePreviewCache {
  private readonly entries = new Map<string, CachedPreview>();

  create(
    columns: readonly string[],
    rows: readonly NamedRow[],
    unsupportedBindColumns: readonly string[] = [],
  ): string {
    const previewId = randomUUID();
    this.entries.set(previewId, clonePreview({
      columns: [...columns],
      rows: [...rows],
      unsupportedBindColumns: [...unsupportedBindColumns],
    }));
    return previewId;
  }

  save(previewId: string, columns: readonly string[], rows: readonly NamedRow[]): void {
    const entry = this.require(previewId);
    if (!sameColumns(entry.columns, columns) || !hasExactRowColumns(rows, entry.columns)) {
      throw new EditablePreviewCacheError("preview rows do not match cached columns");
    }
    this.entries.set(previewId, clonePreview({
      columns: [...columns],
      rows: [...rows],
      unsupportedBindColumns: entry.unsupportedBindColumns,
    }));
  }

  consume(previewId: string): RowSet {
    const entry = this.require(previewId);
    this.entries.delete(previewId);
    return clonePreview(entry);
  }

  discard(previewId: string): void {
    this.entries.delete(previewId);
  }

  private require(previewId: string): CachedPreview {
    const entry = this.entries.get(previewId);
    if (entry === undefined) throw new EditablePreviewCacheError("preview was not found");
    return entry;
  }
}

function sameColumns(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((column, index) => column === actual[index]);
}

function hasExactRowColumns(rows: readonly NamedRow[], columns: readonly string[]): boolean {
  const expected = new Set(columns);
  return rows.every((row) => {
    const keys = Object.keys(row);
    return keys.length === expected.size && keys.every((key) => expected.has(key));
  });
}

function clonePreview(preview: CachedPreview): CachedPreview {
  return structuredClone(preview);
}
