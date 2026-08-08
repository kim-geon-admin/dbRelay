import { invokeCommand } from "./tauri";

it("forwards an allowed typed command to the preload bridge", async () => {
  window.dbRelay = { invoke: vi.fn().mockResolvedValue([]) };

  await expect(invokeCommand("list_connections")).resolves.toEqual([]);
  expect(window.dbRelay.invoke).toHaveBeenCalledWith("list_connections", undefined);
});
