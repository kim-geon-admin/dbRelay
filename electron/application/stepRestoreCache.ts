import { randomUUID } from "node:crypto";

import type { DomainValue } from "../domain/models";

export type RestoreAction =
  | { type: "delete"; rowId: string; expected: Record<string, DomainValue> }
  | { type: "update"; rowId: string; previous: Record<string, DomainValue>; expected: Record<string, DomainValue> };

export type StepRestore = {
  editorSessionId: string;
  stepId: string;
  targetConnectionId: string;
  table: string;
  actions: RestoreAction[];
};

export class StepRestoreCache {
  private readonly entries = new Map<string, StepRestore>();

  create(entry: StepRestore): string {
    const id = randomUUID();
    this.entries.set(id, structuredClone(entry));
    return id;
  }

  require(id: string): StepRestore {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("restore was not found");
    return structuredClone(entry);
  }

  discard(id: string): void { this.entries.delete(id); }

  discardStep(editorSessionId: string, stepId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.editorSessionId === editorSessionId && entry.stepId === stepId) this.entries.delete(id);
    }
  }

  discardOwner(editorSessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.editorSessionId === editorSessionId) this.entries.delete(id);
    }
  }
}
