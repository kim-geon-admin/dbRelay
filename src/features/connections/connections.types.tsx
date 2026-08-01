export type DbKind = "oracle";

export type Connection = {
  id: string;
  displayName: string;
  kind: DbKind;
  host: string;
  port: number;
  serviceName: string;
  username: string;
  enabled: boolean;
};

export type ConnectionSaveInput = Omit<Connection, "enabled"> & {
  enabled?: boolean;
  password?: string;
};

export type ConnectionTestResult = {
  connectionId: string;
  connected: boolean;
};

