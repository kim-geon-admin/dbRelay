# Task 12 Report: Execution, Recovery, and History

## Delivered

- Added the execution dashboard with saved-flow selection, source/target and policy summaries, local preflight gating, ordered step statuses, processed-row counts, duration, and a dark monospaced log.
- Added an accessible recovery modal for `awaiting_recovery` committed-step failures. It exposes exactly Edit and retry, Skip and continue, and Stop; retry validates both SQL fields, while skip and stop require an explicit confirmation with their data-retention warning.
- Added run history and detail views that show safe step and recovery events, including `SkippedByUser`, without rendering source rows or bind values.
- Extended the typed Tauri run/history DTOs with transaction policy and sanitized run events only, allowing the UI to render recovery context without introducing a generic SQL API or secret-bearing payload.

## Test-first evidence

- The new UI tests were added before the implementation and initially failed because the new components did not exist.
- Focused UI tests pass: `pnpm vitest run src/features/run/RecoveryDialog.test.tsx src/features/run/RunDashboard.test.tsx src/features/history/RunDetail.test.tsx` (3 tests).
- Command serialization test passes: `cargo test --manifest-path src-tauri/Cargo.toml --test commands run_history_response_never_serializes_execution_data`.

## Review fix round 1

- Recovery dialog content is keyed by run ID and failed-step index, so a new failure remounts with its own choice mode and SQL values.
- The dialog now focuses its first recovery action, traps Tab and Shift+Tab within visible dialog controls, and restores prior focus when recovery resolves. The dashboard Run control is disabled while recovery is awaiting a decision.
- Execution duration is captured only between the `startRun` request and its response, then stored as a fixed value. Recovery time and later re-renders cannot increase it.
- Added regression tests for remount state reset, modal focus/trapping/restoration, disabled background Run control, and frozen duration.
- Verification: focused run/history tests (7), full UI suite (16), `pnpm lint`, and `pnpm build` passed.

## Final verification

## Review fix round 2

- The dialog now focuses the first valid control after each choice/edit/confirmation mode transition and cycles focus explicitly for Tab and Shift+Tab.
- Regression coverage proves Edit-to-Tab, Back-to-Tab, and Skip/Stop confirmation transitions remain within the modal.
- Verification: focused recovery-dialog tests (4), full UI suite (17), `pnpm lint`, and `pnpm build` passed.

- `pnpm test` — 12 tests passed.
- `pnpm lint` — passed.
- `pnpm build` — passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` — passed; the opt-in Oracle integration test remains ignored because `DB_RELAY_ORACLE_TEST_URL` is not configured.
- `pnpm tauri build` — passed; MSI and NSIS bundles were produced.
