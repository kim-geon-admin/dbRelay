# Compact Structured Shell Design

**Status:** Approved for planning  
**Date:** 2026-08-11

## Goal

Make the Electron shell and connection settings denser and more polished while
retaining the desktop sidebar at every window width.

## Layout

- Reduce the sidebar from 248px to 224px, approximately 10% narrower.
- Remove the small-width rule that converts the sidebar into a top navigation
  bar. Keep the sidebar and content in a horizontal grid at every width.
- Give the shell a bounded minimum inline size. Below that size, normal page
  horizontal scrolling preserves the sidebar/content relationship instead of
  moving navigation above the content.
- Reduce content and sidebar padding, navigation-link height, card padding,
  form spacing, and control height while retaining readable labels and usable
  focus targets.

## Structured panel styling

- Use thin borders, a subtle surface gradient, and a 2px coral leading accent
  on connection forms and cards.
- Apply shallow shadows sparingly to distinguish editable surfaces without
  making the interface look heavy.
- Preserve the current canvas, dark-sidebar, and coral color system.

## Button behavior

- Active buttons use a short background, border, shadow, and `translateY(-1px)`
  hover transition, with an accessible visible focus outline.
- Connection-card Edit and Test controls use compact raised secondary-button
  styling. Disable uses a restrained warning variant.
- Disabled controls do not animate or appear interactive. Use subdued color and
  a small inset treatment so a disabled Test button is recognizably a control
  without competing with active actions.

## Boundaries and verification

- Keep DOM structure, typed IPC, credential masking, and all connection form
  validation behavior unchanged.
- Add focused renderer/style tests for the permanent sidebar layout hooks and
  connection-card action classes.
- Run the focused tests first, then `pnpm test`, `pnpm lint`, `pnpm build`,
  `pnpm package`, and `pnpm vitest run electron/ipc/architecture.test.ts`.
