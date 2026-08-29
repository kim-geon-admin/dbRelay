# Flow Editor Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Format Oracle SQL from focused Flow Editor textareas, clarify preview/run actions, and make preview behavior viewport-safe while retaining automatic target commits.

**Architecture:** Keep all new interaction in the renderer. A focused textarea calls a small Oracle formatter adapter; the existing `onChange` flow remains the sole mutation path. The existing typed `run_flow_step` service keeps its `begin → execute → commit` transaction behavior and gains a regression assertion only.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, `sql-formatter` (Oracle PL/SQL dialect), Electron typed IPC.

**Spec:** `docs/superpowers/specs/2026-08-21-flow-editor-polish-design.md`

## Global Constraints

- Use `sql-formatter@^15.8.2` with its `plsql` Oracle dialect; do not send SQL to a remote service.
- Ctrl+F formats only the currently focused Source or Target SQL textarea and prevents browser find for that event.
- Preview rows remain transient renderer-only state and must not be persisted, logged, or added to other DTOs.
- Do not expose credentials, target bind values, source rows, or generic SQL execution over IPC.
- Preserve existing user changes outside files listed in each task.

---

### Task 1: Add a deterministic Oracle SQL formatter

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/features/flows/sqlFormatting.ts`
- Test: `src/features/flows/sqlFormatting.test.ts`

**Interfaces:**
- Produces: `formatOracleSql(sql: string): string`, which returns Oracle-formatted SQL or throws the formatter parse error.
- Consumed by: `QueryStepEditor` keyboard handling in Task 2.

- [ ] **Step 1: Write the failing formatter test**

```tsx
import { expect, test } from "vitest";
import { formatOracleSql } from "./sqlFormatting";

test("formats an Oracle SELECT without replacing named bind placeholders", () => {
  expect(formatOracleSql("select id,email from customers where id=:customer_id"))
    .toBe("SELECT\n  id,\n  email\nFROM\n  customers\nWHERE\n  id = :customer_id");
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run src/features/flows/sqlFormatting.test.ts`

Expected: FAIL because `./sqlFormatting` does not exist.

- [ ] **Step 3: Install the formatter and implement the adapter**

```powershell
pnpm add sql-formatter@^15.8.2
```

```ts
import { format } from "sql-formatter";

export function formatOracleSql(sql: string): string {
  return format(sql, { language: "plsql", keywordCase: "upper", tabWidth: 2 });
}
```

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run src/features/flows/sqlFormatting.test.ts`

Expected: PASS.

### Task 2: Format the focused SQL field and distinguish action buttons

**Files:**
- Modify: `src/features/flows/QueryStepEditor.tsx`, `src/styles/global.css`
- Test: `src/features/flows/QueryStepEditor.test.tsx`

**Interfaces:**
- Consumes: `formatOracleSql(sql)` from Task 1 and existing `onChange(step)` prop.
- Produces: Source/Target SQL Ctrl+F formatting, a safe `role="alert"` failure message, and `query-step__action--preview` / `query-step__action--run` CSS classes.

- [ ] **Step 1: Write failing editor behavior tests**

```tsx
test("formats only the focused Source SQL when Ctrl+F is pressed", () => {
  render(<StatefulStepEditor initialStep={{ id: "step-1", selectSql: "select id from customers", upsertSql: "insert into customers (id) values (:id)" }} />);
  const source = screen.getByRole("textbox", { name: "Source SQL for step 1" });
  source.focus();
  fireEvent.keyDown(source, { key: "f", ctrlKey: true });
  expect(source).toHaveValue("SELECT\n  id\nFROM\n  customers");
  expect(screen.getByRole("textbox", { name: "Target SQL for step 1" })).toHaveValue("insert into customers (id) values (:id)");
});

test("renders preview and Run as distinct emphasized actions", () => {
  render(<StatefulStepEditor sourceConnectionId="source" targetConnectionId="target" initialStep={{ id: "step-1", selectSql: "SELECT id FROM customers", upsertSql: "INSERT INTO customers (id) VALUES (:id)" }} />);
  expect(screen.getByRole("button", { name: "미리보기" })).toHaveClass("query-step__action--preview");
  expect(screen.getByRole("button", { name: "Run" })).toHaveClass("query-step__action--run");
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run src/features/flows/QueryStepEditor.test.tsx`

Expected: FAIL because neither key handling nor action classes exist.

- [ ] **Step 3: Implement focused keyboard handling and semantic styles**

```tsx
const formatSql = (field: "selectSql" | "upsertSql") => {
  try {
    const formatted = formatOracleSql(step[field]);
    onChange({ ...step, operation, [field]: formatted });
    setActionError(undefined);
  } catch {
    setActionError("SQL could not be formatted. The query was not changed.");
  }
};

const handleSqlKeyDown = (field: "selectSql" | "upsertSql") => (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (!(event.ctrlKey && event.key.toLowerCase() === "f")) return;
  event.preventDefault();
  formatSql(field);
};
```

Attach the handlers to their matching textareas. Add `query-step__action--preview` and `query-step__action--run` classes to the two operation buttons; style them with dark and coral backgrounds respectively, preserving disabled and focus-visible states.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run src/features/flows/QueryStepEditor.test.tsx`

Expected: PASS.

### Task 3: Make the preview modal content-sized and 80%-bounded

**Files:**
- Modify: `src/features/flows/StepPreviewDialog.tsx`, `src/styles/global.css`
- Test: `src/features/flows/StepPreviewDialog.test.tsx`

**Interfaces:**
- Consumes: transient `PreviewFlowStepDto` and existing `onClose` callback.
- Produces: a centered dialog that sizes to its table until `80vw`/`80vh`, with body scroll locked and table-only overflow beyond those limits.

- [ ] **Step 1: Write failing modal tests**

```tsx
test("locks page scrolling while open and restores it when closed", () => {
  document.body.style.overflow = "auto";
  const view = render(<StepPreviewDialog preview={emptyPreview} onClose={vi.fn()} />);
  expect(document.body.style.overflow).toBe("hidden");
  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
});

test("marks its table wrapper as the scrollable preview region", () => {
  render(<StepPreviewDialog preview={{ columns: ["ID"], rows: [{ ID: 1 }] }} onClose={vi.fn()} />);
  expect(screen.getByTestId("step-preview-table-scroll")).toBeVisible();
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx`

Expected: FAIL because the scroll wrapper is not labelled for this behavior.

- [ ] **Step 3: Implement intrinsic, bounded dialog layout**

Add `data-testid="step-preview-table-scroll"` to the existing table wrapper. Keep its overflow behavior. Replace the fixed `1100px` dialog width and near-full viewport height with intrinsic sizing and caps:

```css
.step-preview-backdrop { padding: 10vh 10vw; }
.step-preview-dialog { width: fit-content; max-width: 80vw; max-height: 80vh; }
.step-preview-dialog__table-wrap { max-width: 100%; overflow: auto; }
```

Retain the existing focus trap, backdrop, Escape behavior, and effect cleanup that restores `document.body.style.overflow` and opener focus.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run src/features/flows/StepPreviewDialog.test.tsx`

Expected: PASS.

### Task 4: Verify step-run transaction completion

**Files:**
- Verify only: `electron/application/migrationRunner.test.ts`

**Interfaces:**
- Consumes: `MigrationRunner.runFlowStep({ sourceConnectionId, targetConnectionId, selectSql, upsertSql })`.
- Produces: fresh evidence that the existing regression test proves a successful direct Run commits after executing its batch.

- [ ] **Step 1: Inspect the existing behavior test**

```ts
it("commits the unsaved current step without creating a run", async () => {
  const test = harness("all_or_nothing");
  await expect(test.runner.runFlowStep({
    sourceConnectionId: "source",
    targetConnectionId: "target",
    selectSql: "SELECT id FROM customer",
    upsertSql: "MERGE INTO customer USING dual ON (id = :ID)",
  })).resolves.toEqual({ affectedRows: 1 });
  expect(test.connector.targetTransactions()).toEqual(["begin", "execute:0", "commit"]);
});
```

- [ ] **Step 2: Verify the existing regression test**

Run: `pnpm vitest run electron/application/migrationRunner.test.ts -t "commits the unsaved current step"`

Expected: PASS, confirming the transaction sequence is exactly `begin`, `execute:0`, `commit`.

- [ ] **Step 3: Run the focused flow and architecture suite**

Run: `pnpm vitest run src/features/flows/sqlFormatting.test.ts src/features/flows/QueryStepEditor.test.tsx src/features/flows/StepPreviewDialog.test.tsx electron/application/migrationRunner.test.ts electron/ipc/architecture.test.ts`

Expected: PASS.

### Task 5: Complete verification and record completed todo items

**Files:**
- Modify: `todolist.md`

**Interfaces:**
- Consumes: successful evidence from Tasks 1 through 4 and required project checks.
- Produces: checked items 1 through 5 only when the full suite completes successfully.

- [ ] **Step 1: Run required checks**

```powershell
pnpm test
pnpm lint
pnpm build
pnpm package
```

- [ ] **Step 2: Confirm boundary constraints**

Run: `pnpm vitest run electron/ipc/architecture.test.ts`

Expected: PASS, including no new source-row persistence or generic SQL IPC command.

- [ ] **Step 3: Check only the completed entries**

Replace only the initial `- [ ]` marker on items 1, 2, 3, 4, and 5 in `todolist.md` with `- [x]`. Leave 6 and 7 unchecked.

- [ ] **Step 4: Review the resulting diff**

Run: `git diff --check; git diff -- todolist.md package.json pnpm-lock.yaml src/features/flows/QueryStepEditor.tsx src/features/flows/StepPreviewDialog.tsx src/features/flows/sqlFormatting.ts src/styles/global.css electron/application/migrationRunner.test.ts`

Expected: no whitespace errors and no unrelated modifications in the listed implementation files.
