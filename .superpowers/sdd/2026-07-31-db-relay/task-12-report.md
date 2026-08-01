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

## Final verification

- `pnpm test` — 12 tests passed.
- `pnpm lint` — passed.
- `pnpm build` — passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` — passed; the opt-in Oracle integration test remains ignored because `DB_RELAY_ORACLE_TEST_URL` is not configured.
- `pnpm tauri build` — passed; MSI and NSIS bundles were produced.
