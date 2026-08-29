# Flow Editor Polish Design

**Status:** Approved for implementation

## Scope

Implement items 1 through 5 from `todolist.md` in the existing Flow Editor.
The scope is limited to renderer UI behavior and its already-typed `run_flow_step`
operation. No preview source rows, passwords, bind values, or generic SQL commands
may be persisted or newly exposed over IPC.

## Design

### SQL formatting

Add `sql-formatter` and use its Oracle dialect. When focus is in either Source SQL
or Target SQL textarea, `Ctrl+F` prevents the browser find shortcut and replaces
that textarea's value with the formatter output. Formatting errors leave the input
unchanged and show a safe, generic editor error. Each update continues through the
existing `onChange` path, so generated-operation state remains consistent.

### Action emphasis and execution

Preview and Run remain native buttons but receive separate semantic action classes:
Preview is a dark secondary action and Run is the coral primary action. The current
main-process `runFlowStep` sequence is kept: open source and target sessions, begin
the target transaction, execute named binds, then commit. Any error after begin
rolls back before both sessions close. Tests protect that automatic commit behavior.

### Preview modal

The dialog continues to be an accessible modal with focus trap and Escape close.
While it is open, the backdrop blocks pointer interaction with the editor and body
scrolling is locked. The table and dialog use intrinsic sizing so they grow to their
contents, capped at 80vw and 80vh and centered in the viewport. When either cap is
reached, only the table wrapper scrolls. Closing drops the transient preview object
from React state and restores the opener focus.

## Tests and verification

Add renderer tests for formatting from both SQL fields, action styling, modal body
scroll locking, and preview sizing hooks. Retain/extend the application test that
proves `runFlowStep` commits its target transaction. Run the architecture test and
the required `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package` checks before
checking the five todo entries.
