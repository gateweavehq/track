import { expect, it, vi } from "vitest";
import { createBrowserSyncClient } from "../src/browser";
import { PendingFormatError } from "../src/persistence";

vi.mock("../src/idb", () => ({
	openIdbPersistence: () => Promise.reject(new PendingFormatError(99)),
}));
vi.mock("../src/tabs", async (importOriginal) => {
	const tabs = await importOriginal<typeof import("../src/tabs")>();
	return {
		...tabs,
		supportsBrowserTabs: () => true,
		browserTabs: () => tabs.standaloneTabs(),
	};
});

it("rethrows a pending format failure instead of silently using memory", async () => {
	const onReject = vi.fn();
	const client = createBrowserSyncClient({
		workspace: "test",
		storageKey: "test",
		userId: "test",
		baseUrl: "https://track.example",
		onReject,
	});
	await vi.waitFor(() => expect(client.getStatus().connection).toBe("unreadable"));
	expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ storedUnreadable: true }));
	await client.close();
});
