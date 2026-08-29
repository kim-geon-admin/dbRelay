import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

window.dbRelay = {
  invoke: vi.fn().mockResolvedValue(undefined),
  subscribeRunProgress: vi.fn(() => () => undefined),
};
