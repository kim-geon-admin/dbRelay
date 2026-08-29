# Editable Preview Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit and save preview rows for a flow step, then execute target DML with those transient saved rows rather than re-querying Source SQL.

**Architecture:** `MigrationRunner` owns a new in-memory editable-preview cache. New named IPC commands save and discard a row set under an opaque `previewId`; an optional `previewId` on the existing typed `run_flow_step` consumes the cached data for one target-only transaction. The renderer edits only string cells, manages the cache token, and discards it on editor unmount or invalidating changes.

**Tech Stack:** Electron main/preload typed IPC, TypeScript, React 19, Vitest, Testing Library, Oracle connector.

**Spec:** `docs/superpowers/specs/2026-08-21-editable-preview-cache-design.md`

## Global Constraints

- Raw preview/user-edited rows may cross IPC only through `preview_flow_step`, `save_edited_preview`, and the `previewId` consumed by `run_flow_step`.
- Cache entries are process-memory only; never store them in SQLite, logs, run history, or any generic DTO.
- Cache entries are deleted after a run attempt, explicit discard, editor unmount, or a new preview for the same editor.
- `run_flow_step` must retain the existing Source SQL path when `previewId` is absent and must never add arbitrary SQL execution.
- Preserve unrelated user changes and do not create a commit in the dirty working tree.

---

### Task 1: Add an in-memory editable-preview cache and target-only runner path

**Files:**
- Create: `electron/application/editablePreviewCache.ts`, `electron/application/editablePreviewCache.test.ts`
- Modify: `electron/application/migrationRunner.ts`, `electron/application/migrationRunner.test.ts`

**Interfaces:**
- Produces `EditablePreviewCache.create(columns, rows): string`, `save(previewId, columns, rows): void`, `consume(previewId): { columns: string[]; rows: NamedRow[] }`, and `discard(previewId): void`.
- Extends `MigrationRunner.previewFlowStep` to return `{ previewId, columns, rows }`.
- Produces `MigrationRunner.saveEditedPreview({ previewId, columns, rows })`, `discardEditedPreview(previewId)`, and `runFlowStep({ sourceConnectionId, targetConnectionId, selectSql, upsertSql, previewId? })`.

- [ ] **Step 1: Write failing cache tests**

```ts
it("replaces a preview's rows only when the exact column set matches", () => {
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID", "NAME"], [{ ID: 1, NAME: "Ada" }]);

  cache.save(previewId, ["ID", "NAME"], [{ ID: 1, NAME: "Lin" }]);

  expect(cache.consume(previewId)).toEqual({ columns: ["ID", "NAME"], rows: [{ ID: 1, NAME: "Lin" }] });
  expect(() => cache.consume(previewId)).toThrow(/preview/i);
});

it("rejects rows with missing or extra columns", () => {
  const cache = new EditablePreviewCache();
  const previewId = cache.create(["ID"], [{ ID: 1 }]);
  expect(() => cache.save(previewId, ["ID"], [{ ID: 1, OTHER: "no" }])).toThrow(/columns/i);
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/application/editablePreviewCache.test.ts`

Expected: FAIL because `EditablePreviewCache` is absent.

- [ ] **Step 3: Implement the cache with cloned, non-persistent values**

```ts
export class EditablePreviewCache {
  private readonly entries = new Map<string, { columns: string[]; rows: NamedRow[] }>();

  create(columns: string[], rows: NamedRow[]): string {
    const previewId = randomUUID();
    this.entries.set(previewId, { columns: structuredClone(columns), rows: structuredClone(rows) });
    return previewId;
  }

  consume(previewId: string) {
    const entry = this.require(previewId);
    this.entries.delete(previewId);
    return structuredClone(entry);
  }

  discard(previewId: string): void { this.entries.delete(previewId); }
}
```

Make `save` require the cached column sequence and each row's exact own-key set. Reject unknown IDs and malformed row values with `MigrationRunnerError` codes that project to safe detail text.

- [ ] **Step 4: Write failing runner behavior tests**

```ts
it("runs a saved preview without opening or querying the source", async () => {
  const test = harness("all_or_nothing");
  const preview = await test.runner.previewFlowStep({ sourceConnectionId: "source", selectSql: "SELECT id FROM customer" });
  test.runner.saveEditedPreview({ previewId: preview.previewId, columns: ["ID"], rows: [{ ID: 7 }] });

  await expect(test.runner.runFlowStep({
    sourceConnectionId: "source", targetConnectionId: "target",
    selectSql: "SELECT id FROM customer", upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
    previewId: preview.previewId,
  })).resolves.toEqual({ affectedRows: 1 });

  expect(test.connector.sourceQueries).toHaveLength(1);
  expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "commit"]);
});

it("discards a saved preview after a failed target run", async () => {
  const test = harness("all_or_nothing").targetFailsAt(0);
  const preview = await test.runner.previewFlowStep({ sourceConnectionId: "source", selectSql: "SELECT id FROM customer" });
  test.runner.saveEditedPreview({ previewId: preview.previewId, columns: ["ID"], rows: [{ ID: 7 }] });
  await expect(test.runner.runFlowStep({ sourceConnectionId: "source", targetConnectionId: "target", selectSql: "SELECT id FROM customer", upsertSql: "MERGE INTO customer USING dual ON (id = :ID)", previewId: preview.previewId })).rejects.toMatchObject({ code: "FAKE_EXECUTE" });
  expect(() => test.runner.saveEditedPreview({ previewId: preview.previewId, columns: ["ID"], rows: [{ ID: 8 }] })).toThrow(/preview/i);
});
```

- [ ] **Step 5: Verify runner tests are red**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "saved preview"`

Expected: FAIL because preview responses have no ID and `saveEditedPreview` is absent.

- [ ] **Step 6: Implement the cache path and verify green**

Create the cache in the `MigrationRunner` constructor (defaulting to a new cache for existing test harnesses). Have `previewFlowStep` create a cache entry before returning its transient rows. In `runFlowStep`, consume `previewId` before opening sessions; when it exists, skip source-profile credential resolution, skip `source.query`, validate its batch, and execute the existing target `begin → executeNamed → commit` path. Always discard the token in `finally`; do not add it to a run binding or repository method.

Run: `pnpm vitest run electron/application/editablePreviewCache.test.ts electron/application/migrationRunner.test.ts`

Expected: PASS.

### Task 2: Expose only named editable-preview IPC operations

**Files:**
- Modify: `electron/ipc/commands.ts`, `electron/ipc/handlers.ts`, `electron/preload.test.ts`, `electron/ipc/handlers.test.ts`, `electron/ipc/architecture.test.ts`, `electron/main.ts`, `electron/workflows/workflowTestHarness.ts`, `src/lib/desktop.ts`
- Modify: `AGENTS.md`, `ARCHITECTURE.md`

**Interfaces:**
- Adds command names `save_edited_preview` and `discard_edited_preview`.
- Adds `PreviewFlowStepDto.previewId: string`.
- Adds request types `save_edited_preview: { request: { previewId: string; columns: string[]; rows: Array<Record<string, PreviewCellDto>> } }` and `discard_edited_preview: { request: { previewId: string } }`.
- Extends `run_flow_step.request` with optional `previewId?: string`.

- [ ] **Step 1: Write failing handler and preload tests**

```ts
it("accepts the two named editable-preview commands and rejects malformed saved rows", async () => {
  await expect(handler("save_edited_preview", {
    request: { previewId: "preview-1", columns: ["ID"], rows: [{ ID: 7 }],
  })).resolves.toBeUndefined();
  await expect(handler("save_edited_preview", {
    request: { previewId: "preview-1", columns: ["ID"], rows: "not rows" },
  })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

it("forwards a saved preview ID through the typed run command", async () => {
  await invokeDbRelayCommand(invoke, "run_flow_step", {
    request: { sourceConnectionId: "source", targetConnectionId: "target", selectSql: "SELECT id FROM t", upsertSql: "MERGE INTO t USING dual ON (id = :ID)", previewId: "preview-1" },
  });
  expect(invoke).toHaveBeenCalledWith(DB_RELAY_CHANNEL, "run_flow_step", expect.objectContaining({ request: expect.objectContaining({ previewId: "preview-1" }) }));
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts`

Expected: FAIL because the command allowlist and request guards do not recognise editable preview commands.

- [ ] **Step 3: Implement command maps, validation, and projections**

Update the command allowlist and all mirrored `src/lib/desktop.ts` types. In handlers, call only the runner's `saveEditedPreview` and `discardEditedPreview`; `save_edited_preview` returns `undefined` and `discard_edited_preview` returns `undefined`. Decode preview DTO values back to domain values only in the handler, reject non-finite numbers, unknown object shapes, duplicate/missing column names, and rows with keys outside `columns` before they reach the runner.

Create one `EditablePreviewCache` in `electron/main.ts` and inject it into `MigrationRunner`; do the same in the workflow harness so each application owns one cache. Update the structural test to permit preview row payloads solely in `preview_flow_step` and `save_edited_preview`, permit `previewId` on `run_flow_step`, and continue rejecting rows/binds/secrets from run and history DTOs. Update `AGENTS.md` and `ARCHITECTURE.md` with the explicit, volatile editable-preview exception and all discard conditions.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts`

Expected: PASS.

### Task 3: Add editable preview UI, save state, and unmount cleanup

**Files:**
- Modify: `src/features/flows/flows.types.tsx`, `src/features/flows/flows.api.tsx`, `src/features/flows/StepPreviewDialog.tsx`, `src/features/flows/StepPreviewDialog.test.tsx`, `src/features/flows/QueryStepEditor.tsx`, `src/features/flows/QueryStepEditor.test.tsx`, `src/styles/global.css`

**Interfaces:**
- Produces `saveEditedPreview(input)`, `discardEditedPreview(previewId)`, and `RunFlowStepInput.previewId?: string`.
- Extends `StepPreviewDialog` with `onSave({ columns, rows }): Promise<void>`.
- Produces a saved-preview parent notice and unmount cleanup from `QueryStepEditor`.

- [ ] **Step 1: Write failing dialog and editor tests**

```tsx
test("edits a string preview cell and saves the changed row", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<StepPreviewDialog preview={{ previewId: "preview-1", columns: ["ID", "NAME"], rows: [{ ID: 1, NAME: "Ada" }] }} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.change(screen.getByRole("textbox", { name: "NAME row 1" }), { target: { value: "Lin" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await expect(onSave).toHaveBeenCalledWith({ columns: ["ID", "NAME"], rows: [{ ID: 1, NAME: "Lin" }] });
});

test("runs with the saved preview and discards it when the editor unmounts", async () => {
  vi.mocked(previewFlowStep).mockResolvedValue({ previewId: "preview-1", columns: ["NAME"], rows: [{ NAME: "Ada" }] });
  vi.mocked(saveEditedPreview).mockResolvedValue(undefined);
  const view = render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{ id: "step-1", selectSql: "SELECT name FROM customer", upsertSql: "MERGE INTO customer USING dual ON (name = :NAME)" }} />);
  await userEvent.click(screen.getByRole("button", { name: "미리보기" }));
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(runFlowStep).toHaveBeenCalledWith(expect.objectContaining({ previewId: "preview-1" }));
  view.unmount();
  expect(discardEditedPreview).toHaveBeenCalledWith("preview-1");
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx src/features/flows/QueryStepEditor.test.tsx`

Expected: FAIL because the modal has no Save control and the editor owns no preview token.

- [ ] **Step 3: Implement editable modal state and parent token lifecycle**

In `StepPreviewDialog`, initialize a structured clone of preview rows. Render an accessible textbox only for primitive string cells; render `previewCellText` for every other supported value. Add a header Save button, disable it during `onSave`, and close only after it resolves. Preserve focus trap, Escape close, body lock, and 80% bounded table layout.

In `QueryStepEditor`, store `{ previewId, saved: true }` after successful save, clear the open modal state, and render the exact Korean saved-data message in the parent fieldset. Pass `previewId` to `runFlowStep`; clear local token state after that promise settles. Add an effect cleanup that calls `discardEditedPreview(previewId)` for any current saved token on unmount. Before changing SQL, operation, or either connection, discard and clear the token; opening a later Preview also discards it first. Do not keep preview rows after the dialog closes.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx src/features/flows/QueryStepEditor.test.tsx`

Expected: PASS.

### Task 4: Verify the complete boundary and record the todo items

**Files:**
- Modify: `todolist.md`

**Interfaces:**
- Consumes successful evidence from Tasks 1–3.
- Produces checked items 6 and 7 while leaving 1–5 checked and no other todo content changed.

- [ ] **Step 1: Run focused boundary suite**

Run: `pnpm vitest run electron/application/editablePreviewCache.test.ts electron/application/migrationRunner.test.ts electron/ipc/handlers.test.ts electron/preload.test.ts electron/ipc/architecture.test.ts src/features/flows/StepPreviewDialog.test.tsx src/features/flows/QueryStepEditor.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run required project checks**

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

If packaging still encounters the pre-existing Electron file lock, report that exact condition and do not claim packaging verification.

- [ ] **Step 3: Check the completed todo entries**

Replace only the markers for items 6 and 7 in `todolist.md` from `- [ ]` to `- [x]` after the verification evidence exists.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check; git status --short`

Expected: no whitespace errors. Confirm no cache data is introduced into `electron/infrastructure/sqliteRepository.ts` or any history DTO.
