# Fixed Card Columns Design

## Goal

Keep the transaction policy in Flow library cards and the enabled state and action controls in Database settings cards at stable horizontal positions regardless of the displayed name length.

## Design

Use CSS Grid for both `.flow-card` and `.connection-card`. The name and metadata block occupies a flexible `minmax(0, 1fr)` column. The policy or enabled-state block and the action block occupy their own columns, so they do not move when the name changes. The flexible name block may wrap or truncate within its available width.

The existing mobile breakpoint remains unchanged in intent: cards stack vertically below 768px, preserving the current small-screen reading order and controls.

No React data flow, IPC contract, persistence behavior, or user-visible labels change.

## Testing

Add renderer tests that render cards with short and long names and verify the relevant card regions use the stable layout classes. Existing behavior tests for policy labels and enable/disable actions must continue to pass. Run the required project checks from `AGENTS.md`, including the renderer boundary architecture test.

## Scope

Only the card markup classes needed to identify the grid regions, the shared card CSS, and focused renderer tests are in scope.
