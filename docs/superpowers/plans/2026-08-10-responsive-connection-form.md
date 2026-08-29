# Responsive Connection Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the connection create/edit form visible in normally sized Electron windows while preserving ordinary page scrolling only for windows below the safe layout size.

**Architecture:** Mark the connection form with a component-specific CSS hook, then scope responsive grid and compact-height rules to that hook beneath the Database settings screen. Keep the DOM order and document flow intact: CSS adapts the layout without fixed heights or inner overflow containers.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, CSS, Electron

## Global Constraints

- Current passwords and their values must never be exposed, logged, or added to renderer state beyond the existing `passwordMask` behavior.
- Renderer code remains within the React-to-preload typed IPC boundary; this layout task adds no IPC or connector behavior.
- Keep labels, validation, and controls keyboard-accessible in their existing DOM order.
- Do not add a fixed content height or an internal scroll container; normal document scrolling remains the fallback below the compact layout threshold.
- Required checks are `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm package`, and `pnpm vitest run electron/ipc/architecture.test.ts`.

---

## File Structure

- `src/features/connections/ConnectionForm.tsx` — exposes the connection-form CSS hook without changing validation or saving behavior.
- `src/features/connections/ConnectionForm.test.tsx` — verifies the hook is attached to the rendered semantic form.
- `src/styles/global.css` — contains connection-screen-scoped grid, compact-height, and narrow-width layout rules.

### Task 1: Expose and verify the scoped form layout hook

**Files:**

- Modify: `src/features/connections/ConnectionForm.test.tsx`
- Modify: `src/features/connections/ConnectionForm.tsx:87-109`

**Interfaces:**

- Consumes: `ConnectionForm` props `{ connection?, onSave, onCancel? }`.
- Produces: a semantic `<form>` with classes `editor-form connection-form`; existing consumer props and submit behavior remain unchanged.

- [ ] **Step 1: Write the failing test**

  Add this test to `src/features/connections/ConnectionForm.test.tsx`:

  ```tsx
  it("marks the connection editor for scoped responsive layout", () => {
    render(<ConnectionForm onSave={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Save connection" }).closest("form"))
      .toHaveClass("connection-form");
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `pnpm vitest run src/features/connections/ConnectionForm.test.tsx`

  Expected: FAIL because the rendered form has `editor-form` but not `connection-form`.

- [ ] **Step 3: Add the minimal component hook**

  Change the opening form element in `ConnectionForm.tsx` to:

  ```tsx
  <form className="editor-form connection-form" onSubmit={submit} noValidate>
  ```

  Do not alter the inputs, validation, or form state.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `pnpm vitest run src/features/connections/ConnectionForm.test.tsx`

  Expected: PASS, including the new layout-hook assertion and existing validation tests.

- [ ] **Step 5: Commit the focused change**

  ```powershell
  git add src/features/connections/ConnectionForm.tsx src/features/connections/ConnectionForm.test.tsx
  git commit -m "test: identify responsive connection form"
  ```

### Task 2: Implement responsive connection-form sizing

**Files:**

- Modify: `src/styles/global.css:250-294`

**Interfaces:**

- Consumes: `.connection-settings` from `ConnectionList` and `.connection-form` from Task 1.
- Produces: a two-column form at desktop widths, one-column layout at narrow widths, and bounded compact vertical sizing without changing document overflow.

- [ ] **Step 1: Add scoped responsive CSS**

  Add the following rules after the base `.editor-form` rules in `src/styles/global.css`:

  ```css
  .connection-settings .connection-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: clamp(6px, 1vh, var(--space-3));
    margin: clamp(10px, 2vh, var(--space-5)) 0;
    padding: clamp(10px, 2vh, var(--space-5));
  }

  .connection-settings .connection-form > h2,
  .connection-settings .connection-form > [role="alert"],
  .connection-settings .connection-form > .editor-actions {
    grid-column: 1 / -1;
  }

  .connection-settings .connection-form input,
  .connection-settings .connection-form select,
  .connection-settings .connection-form button {
    min-height: 0;
    padding-block: clamp(4px, 0.7vh, 8px);
  }

  @media (max-width: 767px) {
    .connection-settings .connection-form { grid-template-columns: 1fr; }
  }
  ```

  Do not set `height`, `max-height`, `overflow`, or `overflow-y` on the connection settings or form selectors.

- [ ] **Step 2: Run the focused renderer test**

  Run: `pnpm vitest run src/features/connections/ConnectionForm.test.tsx`

  Expected: PASS. The form preserves existing validation and the responsive CSS remains dependent on the component hook verified in Task 1.

- [ ] **Step 3: Visually verify the responsive breakpoints in Electron**

  Run: `pnpm dev`

  In the Database settings route, open **New connection** and verify all of the following:

  - At a normal desktop window width, fields render in two columns and the full form fits without an internal scrollbar.
  - At widths below 768px, fields render in one column without horizontal clipping.
  - At a short but normally usable window height, the reduced form padding, gaps, and controls keep the form compact.
  - At a window height smaller than the compact form, the document page scrolls and neither the form nor the settings section receives an independent scrollbar.

- [ ] **Step 4: Commit the responsive layout**

  ```powershell
  git add src/styles/global.css
  git commit -m "feat: make connection form responsive"
  ```

### Task 3: Verify release and process boundaries

**Files:**

- No source changes expected.

**Interfaces:**

- Consumes: completed Tasks 1 and 2.
- Produces: evidence that the renderer change does not violate the Electron process boundary and packages successfully.

- [ ] **Step 1: Run the protected architecture test**

  Run: `pnpm vitest run electron/ipc/architecture.test.ts`

  Expected: PASS; the renderer has no forbidden imports and connection DTOs still expose `passwordMask` rather than raw passwords.

- [ ] **Step 2: Run all unit and renderer tests**

  Run: `pnpm test`

  Expected: PASS.

- [ ] **Step 3: Run code-quality validation**

  Run: `pnpm lint`

  Expected: PASS.

- [ ] **Step 4: Build the desktop application**

  Run: `pnpm build`

  Expected: PASS and emit the production renderer/main-process output.

- [ ] **Step 5: Package the Electron application**

  Run: `pnpm package`

  Expected: PASS and produce the Windows package artifact.
