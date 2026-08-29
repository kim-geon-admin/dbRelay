# Compact Structured Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a compact sidebar at every window width and give DB Relay's settings surfaces and controls a denser structured-panel finish.

**Architecture:** The existing React component tree remains unchanged except for named connection-card action classes. Scoped CSS controls the permanent shell grid, compact spacing, structured surfaces, and button interaction states. Root-level Vitest stylesheet tests protect key layout and action selectors without leaking Node imports into renderer source.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Electron

## Global Constraints

- Keep the sidebar at 224px and never convert it to top navigation.
- Below the shell's usable minimum width, preserve the sidebar/content relationship with normal page horizontal scrolling rather than reflowing the sidebar above content.
- Preserve renderer/preload/main-process boundaries, connection validation behavior, and password masking.
- Active buttons get compact raised hover styling; disabled buttons stay non-interactive and visually subdued.
- Required checks are `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm package`, and `pnpm vitest run electron/ipc/architecture.test.ts`.

---

## File Structure

- `src/styles/global.css` — shell geometry, compact component dimensions, structured panels, and button states.
- `src/features/connections/ConnectionList.tsx` — semantic class names for connection-card actions.
- `app-shell-layout.test.ts` — static CSS regression checks for permanent sidebar geometry.
- `connection-card-actions.test.ts` — static CSS regression checks for raised and disabled action styling.

### Task 1: Keep the compact sidebar in place

**Files:**

- Create: `app-shell-layout.test.ts`
- Modify: `src/styles/global.css:35-117`

**Interfaces:**

- Consumes: `.app-shell`, `.app-sidebar`, `.app-content`, and `.app-navigation` rendered by `AppShell`.
- Produces: a 224px sidebar shell whose page content scrolls horizontally only after the minimum usable shell width is reached.

- [ ] **Step 1: Write the failing CSS contract test**

  Create `app-shell-layout.test.ts`:

  ```ts
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import { expect, it } from "vitest";

  const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

  it("keeps a compact sidebar instead of reflowing it above content", () => {
    expect(styles).toContain("grid-template-columns: 224px minmax(420px, 1fr);");
    expect(styles).toContain("min-width: 644px;");
    expect(styles).not.toContain(".app-shell {\n    display: block;");
  });
  ```

- [ ] **Step 2: Run the test and verify it fails**

  Run: `pnpm vitest run app-shell-layout.test.ts`

  Expected: FAIL because the shell still uses a 248px sidebar and the mobile media query changes it to `display: block`.

- [ ] **Step 3: Apply the compact permanent-shell CSS**

  In `global.css`, replace the shell and small-width rules with these effective declarations:

  ```css
  .app-shell {
    display: grid;
    grid-template-columns: 224px minmax(420px, 1fr);
    min-width: 644px;
    min-height: 100vh;
  }

  .app-sidebar { gap: var(--space-5); padding: var(--space-5) var(--space-3); }
  .app-content { padding: clamp(var(--space-4), 3vw, var(--space-6)); }
  .app-navigation__link { min-height: 30px; padding: 6px var(--space-2); font-size: 0.8125rem; }
  ```

  Delete the `@media (max-width: 767px)` rules that set `.app-shell` to `display: block`, turn `.app-navigation` into a horizontal flex list, or hide its active-link marker. Retain only compact content padding rules that do not change sidebar placement.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `pnpm vitest run app-shell-layout.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit the shell layout**

  ```powershell
  git add src/styles/global.css app-shell-layout.test.ts
  git commit -m "feat: keep compact sidebar at every width"
  ```

### Task 2: Add structured panels and refined connection actions

**Files:**

- Create: `connection-card-actions.test.ts`
- Modify: `src/features/connections/ConnectionList.tsx:42-46`
- Modify: `src/styles/global.css:235-327`

**Interfaces:**

- Consumes: `.connection-card` and its Edit/Test/Disable buttons.
- Produces: `connection-card__action`, `connection-card__action--warning`, and native disabled-state CSS hooks with no behavior changes to their click handlers.

- [ ] **Step 1: Write the failing CSS contract test**

  Create `connection-card-actions.test.ts`:

  ```ts
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import { expect, it } from "vitest";

  const styles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

  it("gives connection actions raised, disabled, and warning states", () => {
    expect(styles).toContain(".connection-card__action:hover:not(:disabled)");
    expect(styles).toContain(".connection-card__action:disabled");
    expect(styles).toContain(".connection-card__action--warning");
  });
  ```

- [ ] **Step 2: Run the test and verify it fails**

  Run: `pnpm vitest run connection-card-actions.test.ts`

  Expected: FAIL because the action selectors do not yet exist.

- [ ] **Step 3: Mark the three card actions by intent**

  Change the action buttons in `ConnectionList.tsx` to use:

  ```tsx
  <button className="connection-card__action" onClick={() => setEditing(connection)}>Edit</button>
  <button className="connection-card__action" onClick={() => void test(connection)} disabled={!connection.enabled}>Test</button>
  <button className="connection-card__action connection-card__action--warning" onClick={() => void disable(connection)}>Disable</button>
  ```

  Do not change callbacks, disabled conditions, labels, or connection state.

- [ ] **Step 4: Apply compact structured-surface and action CSS**

  Add these scoped styles after the shared card/button rules:

  ```css
  .editor-form,
  .connection-card,
  .flow-card {
    border-color: color-mix(in srgb, var(--color-hairline) 82%, var(--color-coral));
    box-shadow: 0 2px 8px rgb(24 23 21 / 5%);
  }

  .connection-settings .editor-form,
  .connection-card {
    border-left: 2px solid var(--color-coral);
  }

  .connection-card__action {
    min-height: 28px;
    padding: 5px 8px;
    border-color: color-mix(in srgb, var(--color-hairline) 72%, var(--color-ink));
    box-shadow: 0 1px 2px rgb(24 23 21 / 10%);
    transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
  }

  .connection-card__action:hover:not(:disabled) {
    background: #fff;
    border-color: var(--color-coral-active);
    box-shadow: 0 3px 7px rgb(24 23 21 / 14%);
    transform: translateY(-1px);
  }

  .connection-card__action:disabled {
    background: color-mix(in srgb, var(--color-card) 72%, var(--color-dark));
    color: color-mix(in srgb, var(--color-on-dark-muted) 65%, var(--color-card));
    box-shadow: inset 0 1px 2px rgb(24 23 21 / 18%);
  }

  .connection-card__action--warning:hover:not(:disabled) {
    border-color: var(--color-error);
    color: var(--color-error);
  }
  ```

  Reduce shared card padding to `var(--space-3)`, form padding to `var(--space-4)`, form margin to `var(--space-4) 0`, and default control padding to `6px 8px` without reducing the shared 32px minimum control height.

- [ ] **Step 5: Run focused tests and verify they pass**

  Run: `pnpm vitest run connection-card-actions.test.ts src/features/connections/ConnectionForm.test.tsx`

  Expected: PASS; the new style contract is present and existing connection behavior remains intact.

- [ ] **Step 6: Commit the polished components**

  ```powershell
  git add src/features/connections/ConnectionList.tsx src/styles/global.css connection-card-actions.test.ts
  git commit -m "feat: refine structured connection panels"
  ```

### Task 3: Verify renderer and package boundaries

**Files:**

- No source changes expected.

**Interfaces:**

- Consumes: completed Tasks 1 and 2.
- Produces: evidence that the compact visual change retains renderer boundaries and builds correctly.

- [ ] **Step 1: Run architecture protection**

  Run: `pnpm vitest run electron/ipc/architecture.test.ts`

  Expected: PASS.

- [ ] **Step 2: Run all tests**

  Run: `pnpm test`

  Expected: PASS.

- [ ] **Step 3: Run lint and production build**

  Run: `pnpm lint; pnpm build`

  Expected: both commands exit 0.

- [ ] **Step 4: Run Windows packaging**

  Run: `pnpm package`

  Expected: PASS and emit the NSIS installer. If the known `release\\win-unpacked.tmp\\resources\\default_app.asar` lock recurs, record the exact error without deleting or renaming the locked artifact.
