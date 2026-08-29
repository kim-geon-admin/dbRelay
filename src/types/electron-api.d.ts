interface Window {
  dbRelay: {
    invoke(command: string, request?: unknown): Promise<unknown>;
    subscribeRunProgress(listener: (progress: {
      runId: string; step: number; processedRows: number; totalRows: number;
      completedBatches: number; totalBatches: number;
    }) => void): () => void;
  };
}
