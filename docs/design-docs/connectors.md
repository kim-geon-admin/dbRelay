# Connector Design Notes

`DatabaseConnector` is the extension boundary for database drivers. A connector validates a connection profile, queries rows, executes named-bind upserts, and controls target transactions while preserving database-native error information in a safe `ConnectorError`.

The first implementation is `OracleConnector`, which executes Oracle `MERGE` statements. Future connectors register through `ConnectorRegistry`; `MigrationRunner` remains connector-agnostic.

Connectors receive credential material only at execution time. They must not write secrets, bind values, source rows, or connection strings containing passwords to logs, history, or command DTOs.
