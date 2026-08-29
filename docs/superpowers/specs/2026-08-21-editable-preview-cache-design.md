# Editable Preview Cache Design

**Status:** Approved for implementation

## Goal

Allow a user to edit preview cells, save the edited result transiently, and run
the target DML against that saved result without querying Source SQL again.

## Explicit Boundary Expansion

Preview source rows and user-edited rows may cross the typed IPC boundary only
for the named editable-preview commands in this design. They remain prohibited
from SQLite, logs, run history, generic DTOs, and generic SQL commands. The
main process keeps saved preview data only in an in-memory cache; no process
restart can recover it.

## Typed Data Flow

1. `preview_flow_step` queries the source and returns its rows plus an opaque
   `previewId`.
2. The renderer holds the rows only while the modal is open. The modal allows
   editable text cells and retains non-text Oracle values as read-only display
   values so type semantics cannot be forged in the UI.
3. `save_edited_preview` receives `{ previewId, columns, rows }`, validates
   the exact preview column set and safe cell JSON shape, then replaces the
   main-process memory entry. It returns no rows.
4. The renderer stores only `previewId` and a saved flag after a successful
   save, closes the modal, and shows the parent status: "사용자가 변경한
   데이터로 DML 처리 합니다".
5. `run_flow_step` receives an optional `previewId`. When present, the runner
   consumes that cached row set, validates target binds, begins the target
   transaction, executes, commits, and never opens a source session. When
   absent it preserves the existing source-query behavior.

## Cache Lifetime

The main-process cache entry is deleted after any attempt to execute it,
whether successful or failed. It is also deleted when the editor sends an
explicit `discard_edited_preview` command, including cleanup from
`QueryStepEditor` unmount. A saved entry is never written to disk or copied
to run history.

## UI

The preview modal receives editable row state and a Save button in its
upper-right header. Save is disabled while an existing save is pending. On
success the modal closes and the parent message replaces the normal preview
state. A later Preview replaces and discards any existing saved entry for the
same query step. Run uses the saved entry when one exists; editing Source SQL,
Target SQL, operation, source connection, or target connection discards it
before allowing another Run.

## Tests

Cover preview IDs, IPC rejection of malformed row payloads, cache-only runs
that do not open a source session, cache deletion after execution, and cache
deletion on editor unmount. Renderer tests cover editable text cells, Save,
the parent status message, and sending the saved preview ID to Run. The
architecture test documents and restricts this new, named preview-data
exception.
