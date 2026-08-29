# Run History Metadata and Presentation

## Decision

Execution history stores a safe snapshot of the flow context needed to identify a run: flow ID, flow name, flow version, and source/target connection display names. Recovery bindings may include non-secret configuration fingerprints, but never executable SQL, bind values, source rows, credentials, or credential references.

When a run is created with a flow binding, every subsequent state write must use the bound-run persistence path. This is required for all-or-nothing success, rollback, commit failure, preflight failure, and in-doubt transitions; a state-only update must not erase the flow metadata snapshot.

Legacy history rows without a stored flow name may resolve it from the saved flow definition when their flow ID still exists. If it cannot be resolved, the safe history projection uses an empty display value.

## Renderer behavior

History entries are ordered by `startedAt` descending, with the run ID as a deterministic tie-breaker. The flow name is shown as the card/detail title. A separate redundant `Flow: ...` row is not rendered. Status, timestamps, policy, step results, and recovery events remain visible.

## Safety constraints

The history DTO and renderer must continue to exclude passwords, SQL text, bind values, source rows, and connection secrets. This document complements the product specification and `ARCHITECTURE.md` boundary rules.
