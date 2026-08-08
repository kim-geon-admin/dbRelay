import type { DbKind } from "../domain/models";
import { ConnectorError, type DatabaseConnectorFactory } from "./databaseConnector";
import { OracleConnector } from "./oracleConnector";

export class ConnectorRegistry {
  private readonly connectors: ReadonlyMap<DbKind, DatabaseConnectorFactory>;

  constructor(connectors: readonly DatabaseConnectorFactory[] = [new OracleConnector()]) {
    this.connectors = new Map(connectors.map((connector) => [connector.kind, connector]));
  }

  forKind(kind: DbKind): DatabaseConnectorFactory {
    const connector = this.connectors.get(kind);
    if (connector === undefined) {
      throw new ConnectorError("CONNECTOR_NOT_FOUND", `connector not found for ${kind}`);
    }
    return connector;
  }
}

export type { DatabaseConnectorFactory, DatabaseSession } from "./databaseConnector";
export { ConnectorError } from "./databaseConnector";
