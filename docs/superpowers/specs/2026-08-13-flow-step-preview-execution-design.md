# Flow Step Preview and Immediate Execution Design

**Status:** approved for implementation  
**Date:** 2026-08-13

## Goal

Let a user preview every result row from the current step's Source SQL and immediately execute only that current step while editing a flow.

## Scope

- Add `미리보기` and `Run` controls immediately above the UPDATE `Review` guidance in each query-step editor.
- Change the UPDATE guidance and generated SQL comment to: `생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오`.
- Preview executes the current Source SQL against the selected source connection and presents all returned rows in an accessible table modal.
- Run executes the current Source SQL and current Target SQL against the selected source and target connections, committing only that one step when it succeeds.
- Run success reports the affected-row count. Failure reports the safe Oracle error code plus the existing Korean code explanation.

## Explicit Boundary Exception

Preview requires source rows to cross the typed IPC boundary. The application permits this only for the `preview_flow_step` response, which is held in renderer memory until its modal closes. Preview rows must not be written to SQLite, execution history, diagnostic logs, or any run DTO. Passwords and bind values remain excluded from all IPC responses.

## Architecture

The preload allowlist gains two specific commands rather than a generic SQL command. `preview_flow_step` accepts a source connection ID and Source SQL, verifies the profile, opens a source connector session, and returns display-safe column metadata and every source row. `run_flow_step` accepts distinct source and target connection IDs plus the current Source and Target SQL, applies the same SQL and bind validation used by flow execution, executes one target transaction, and returns only the affected-row count.

The main-process application service owns both operations. It resolves profiles and credentials internally, so the renderer never receives credentials or target bind rows. Connector exceptions continue through the existing safe command-error projection. The renderer uses `formatConnectorError` to append the Korean Oracle explanation to a failed Run notice.

## UI and State

Each `QueryStepEditor` receives the flow's selected connection IDs. Its controls appear above the UPDATE Review hint; insert steps retain their generation hint and still expose the two controls. Buttons are disabled when required connection IDs or the relevant SQL are absent, and are disabled while that operation is pending.

Opening preview requests all result rows and presents a modal with a caption, close button, horizontally scrollable table, header cells from returned columns, and an explicit empty-result state. Closing the modal clears the stored rows. The modal never renders raw target bind values.

Running a step requests the current in-memory editor values, including unsaved edits. On success, the editor displays a success status with the executed row count. On failure, it displays the projected Oracle code and its Korean name and remediation text. A run cannot execute when source and target profiles are identical.

## Error Handling

Request validation rejects malformed IDs, missing SQL, and same source/target connections before a connector session is opened. Source-query errors and target execution errors are projected as the existing safe command-error DTO. Oracle codes remain normalized (for example, `ORA-00001`), and unknown codes use the existing Korean fallback. The renderer must not display raw driver messages that could contain credentials or row data.

## Testing

- Add application tests for preview returning all connector rows without persistence and immediate execution committing one step.
- Add IPC/preload tests proving only the two named commands are allowed and their response DTOs omit secrets and bind values.
- Extend architecture tests to allow source rows only in the preview response and prohibit them in run/history DTOs and persistence.
- Add renderer tests for button placement, modal table/empty state/row clearing, success count, and localized Oracle failure notice.
- Update SQL-generation and query-step editor tests for the Korean Review copy.

## Verification

Run the focused tests while developing, then run `pnpm vitest run electron/ipc/architecture.test.ts`, `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm package`.
