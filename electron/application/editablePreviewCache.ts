import { randomUUID } from "node:crypto";

import type { NamedRow, RowSet } from "../domain/models";

type CachedPreview = RowSet;

export class EditablePreviewCacheError extends Error {
  constructor(message: string, public readonly code = "PREVIEW_NOT_FOUND") {
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

  // Edited rows are stored as sent: column, shape, and type mismatches stay in
  // the cache so the run reports them against the real target instead of
  // blocking the save.
  save(previewId: string, columns: readonly string[], rows: readonly NamedRow[]): void {
    const entry = this.require(previewId);
    this.entries.set(previewId, clonePreview({
      columns: columns.length === 0 ? [...entry.columns] : [...columns],
      rows: rows.map((row) => ({ ...row })),
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

function clonePreview(preview: CachedPreview): CachedPreview {
  return structuredClone(preview);
}
