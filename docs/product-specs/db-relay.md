# DB Relay Product Specification

DB Relay lets a local Windows user define reusable migration flows between configured databases. The first connector is Oracle.

Each flow references a source and target connection setting, an ordered list of source-query/target-upsert steps, and either `all_or_nothing` or `commit_successes` transaction policy. Column aliases map case-insensitively to named target bind parameters; missing or duplicate mappings block execution before it starts.

`all_or_nothing` performs every target change in one transaction and rolls back all changes if a step fails. `commit_successes` commits successful steps independently, then pauses after a failed step for one explicit action: edit and retry, skip and continue, or stop.

Execution history records safe status, timing, counts, native error context, and recovery choices. It never stores or displays credentials, bind values, or source rows.
