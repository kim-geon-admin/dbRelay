import { invokeCommand } from "./desktop";

it("forwards an allowed typed command to the preload bridge", async () => {
  window.dbRelay = { invoke: vi.fn().mockResolvedValue([]), subscribeRunProgress: vi.fn(() => () => undefined) };

  await expect(invokeCommand("list_connections")).resolves.toEqual([]);
  expect(window.dbRelay.invoke).toHaveBeenCalledWith("list_connections", undefined);
});
