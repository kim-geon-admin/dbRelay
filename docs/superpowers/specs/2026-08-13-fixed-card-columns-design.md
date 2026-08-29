# Fixed Card Columns and Readable SQL Editor Design

## Goal

Keep the transaction policy in Flow library cards and the enabled state and action controls in Database settings cards at stable horizontal positions regardless of the displayed name length. Make the SQL editors in Flow editing readable for multi-line queries without changing their saved values or editing behavior.

## Design

Use CSS Grid for both `.flow-card` and `.connection-card`. Flow cards use a flexible details column and a fixed actions column; the transaction policy is displayed in the details metadata row beside the query-step count. Connection cards use a flexible details column followed by fixed enabled-state and actions columns. Long names stay within the flexible column and do not move the right-side controls.

The existing mobile breakpoint remains unchanged in intent: cards stack vertically below 768px, preserving the current small-screen reading order and controls.

Add a reusable `SqlEditor` renderer component for Source SQL and Target SQL. The textarea remains the real editable control, while a synchronized presentation layer renders escaped SQL with highlighted keywords. No line-number gutter is rendered.

The SQL editor is resized as one container so the textarea and highlighted layer share the same height. Scroll position is clamped to the actual scrollable range and synchronized after content changes and container resizing. The scrollbar uses the dark editor palette, and focus does not add an orange inner border.

No data flow, IPC contract, persistence behavior, or user-visible labels change.

## Testing

Add renderer tests that render cards with short and long names and verify the relevant card regions use the stable layout classes. Add SQL editor tests for keyword highlighting and confirm that no line-number gutter is rendered. Existing behavior tests for policy labels and enable/disable actions must continue to pass. Run the required project checks from `AGENTS.md`, including the renderer boundary architecture test.

## Scope

Only the card markup/classes, the reusable SQL editor presentation layer, shared renderer CSS, and focused renderer tests are in scope. Line-number rendering, SQL parsing, query execution, persistence, IPC contracts, and database behavior remain out of scope.
