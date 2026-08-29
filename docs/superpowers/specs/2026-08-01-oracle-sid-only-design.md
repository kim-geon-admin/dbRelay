# Oracle SID-Only Connection Design

**Status:** Approved for planning

## Goal

Make every Oracle connection use an Oracle SID rather than a service name, so a saved connection such as `192.168.0.7:16005` with SID `xe` is opened using the Oracle driver's SID connect descriptor.

## Scope

- Replace the user-facing **Service name** label with **SID**.
- Rename the frontend and command API properties from `serviceName` / `service_name` to `sid`.
- Rename the domain `ConnectionProfile` property to `sid`.
- Preserve the existing SQLite `service_name` column and its data; interpret it as the SID during reads and writes. No destructive metadata migration is required.
- Build Oracle configurations with `Config::with_sid(host, port, sid, username, password)`.
- Cover the new API shape, persistence compatibility, and connector configuration with regression tests.

## Non-goals

- Supporting both SID and service-name connection modes.
- Changing saved connection identifiers, hosts, ports, users, or credentials.
- Changing other database connector contracts.

## Data flow

```text
Connection form (SID)
  -> frontend DTO (sid)
  -> Tauri request/response DTO (sid)
  -> ConnectionProfile.sid
  -> SQLite service_name column (compatibility storage)
  -> Oracle Config::with_sid(...)
```

Existing records retain their current `service_name` value. On the first read after this change, that value is returned as `sid`; no rewrite is necessary.

## Error handling

The existing connection-test command continues to return sanitized driver errors. The scope only changes how a connect descriptor is formed. It does not expose a password or modify credential storage.

## Verification

- Frontend test verifies that the form presents and submits a SID value.
- Command and persistence tests verify the `sid` DTO/domain mapping while retaining legacy SQLite data.
- Connector test verifies the SID configuration path is selected.
- Targeted frontend and Rust suites, then the repository-required checks, verify the change.
