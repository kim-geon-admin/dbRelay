# Responsive Connection Form Design

**Status:** Approved for planning  
**Date:** 2026-08-10

## Goal

Keep the connection create/edit form within a normally sized Electron window without
introducing an internal scroll container. If the user reduces the window below the
safe layout threshold, retain normal document scrolling so that every field remains
reachable.

## Scope

This change applies to the Database settings connection form only. It does not try to
force an arbitrary number of saved connection cards into one viewport.

## Layout behavior

- At widths that can accommodate it, lay out connection fields in two equal columns.
  The form heading, validation message, and actions span both columns.
- At narrow widths, return the connection fields to one column so controls do not
  become too narrow.
- Use viewport-height-aware, bounded spacing and control sizing for the connection
  form. The compact values apply only while they preserve readable labels and usable
  inputs.
- Do not impose a fixed viewport height or `overflow: auto` on the connections
  content. When the available window is smaller than the bounded compact layout,
  the existing document/page scroll remains available.

## Boundaries and accessibility

- Keep all fields, labels, validation, and save/cancel actions in normal DOM order.
- Preserve keyboard navigation and existing form semantics.
- Scope CSS selectors to `.connection-settings` so flow editing and other screens do
  not inherit the denser connection-form layout.
- No Electron, IPC, persistence, connector, or credential behavior changes are
  required.

## Verification

- Add/adjust a renderer test that identifies the connection form's responsive layout
  hook and preserves its field/action structure.
- Run the affected renderer tests and the required full checks: `pnpm test`,
  `pnpm lint`, `pnpm build`, and `pnpm package`.
- Run `pnpm vitest run electron/ipc/architecture.test.ts` because this work changes
  renderer styling and structure.
