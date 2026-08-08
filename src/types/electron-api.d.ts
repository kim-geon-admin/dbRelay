interface Window {
  dbRelay: {
    invoke(command: string, request?: unknown): Promise<unknown>;
  };
}
