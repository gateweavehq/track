import { expect, it, vi } from "vitest";
import { readSources } from "./sources";

const replacement = vi.hoisted(() => ({ made: false }));
vi.mock("./auth", () => ({
	db: {},
	getAuth: () => ({ api: { getSession: () => ({ user: { id: "owner" } }) } }),
}));
vi.mock("./demo/mode", () => ({ demoEnabled: () => false }));
vi.mock("./workspaces", () => ({
	findMembership: () => ({ workspaceId: "workspace", profile: { id: "owner", role: "owner" } }),
	workspaceStub: () => ({
		sourcesForAdmin: async () => {
			// The replacement makes a key after the object took its snapshot, before the reply arrives.
			const generation = replacement.made ? "new-" : "old-";
			replacement.made = true;
			return { ok: true, value: [{ id: "source", generation }] };
		},
	}),
}));
vi.mock("./source-keys", () => ({
	sourceKeys: async () => (replacement.made ? [{ sourceId: "source", id: "new-key" }] : []),
}));

it("Settings never lists a replacement's working key under removed sources", async () => {
	const request = new Request("https://track.test/settings");
	expect((await readSources("workspace", request))?.keys).toEqual([]);
	expect((await readSources("workspace", request))?.keys).toEqual([
		{ sourceId: "source", id: "new-key" },
	]);
});
