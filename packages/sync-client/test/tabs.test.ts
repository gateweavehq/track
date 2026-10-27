import { afterEach, describe, expect, it } from "vitest";
import { browserTabs, openIdbPersistence, supportsBrowserTabs } from "../src";
import {
	issueBy,
	make,
	type TestNetwork,
	TestWorkspace,
	waitFor,
	waitForConvergence,
	waitForLive,
} from "./harness";

let workspace: TestWorkspace;

afterEach(async () => {
	await workspace?.close();
});

/** Opens a "tab": a client sharing IndexedDB, a BroadcastChannel and a lock with its siblings. */
function opener(ws: TestWorkspace, network: TestNetwork) {
	const key = `tabs-${ws.id}`;
	return () =>
		ws.client("alice", {
			network,
			persistence: openIdbPersistence(key),
			tabs: browserTabs(`tangent:${key}`),
		});
}

// Node provides BroadcastChannel and the Web Locks API, so these run the browser code as is.
describe.skipIf(!supportsBrowserTabs())("tabs", () => {
	it("share one connection", async () => {
		workspace = new TestWorkspace();
		const network = workspace.network("alice");
		const openTab = opener(workspace, network);
		const leader = openTab();
		await waitForLive(leader);
		const follower = openTab();
		await waitFor(() => follower.getStatus().loaded);
		await waitFor(() => follower.getStatus().connection === "live");
		expect(network.connects).toBe(1);

		// A follower's mutation shows in both tabs at once, and the leader sends it.
		const team = make.team();
		const confirmed = follower.mutate(team);
		expect(follower.getState().teams.has(team.args.id)).toBe(true);
		await waitFor(() => leader.getState().teams.has(team.args.id));
		await confirmed;
		await waitForConvergence(leader, follower);

		// Other users' changes reach the follower through the leader.
		const bob = await workspace.live("bob");
		await bob.mutate(make.issue(team.args.id, "From Bob"));
		await waitFor(() => follower.getState().issues.size === 1);
		expect(issueBy(follower, "From Bob")).toEqual(issueBy(leader, "From Bob"));
		expect(network.connects).toBe(1);
	});

	it("hand the connection over when the leader closes", async () => {
		workspace = new TestWorkspace();
		const bob = await workspace.live("bob");
		const network = workspace.network("alice");
		const openTab = opener(workspace, network);
		const leader = openTab();
		await waitForLive(leader);
		const team = make.team();
		await leader.mutate(team);
		const follower = openTab();
		await waitFor(() => follower.getState().teams.has(team.args.id));

		// The follower edits while offline; its mutation waits with the leader.
		network.offline();
		await waitFor(() => follower.getStatus().connection === "offline");
		const confirmed = follower.mutate(make.issue(team.args.id, "Written in the follower"));
		await waitFor(() => leader.getStatus().pending === 1);

		// The leader closes before it could send it. The follower takes over and sends it.
		await leader.close();
		network.online();
		await confirmed;
		await waitFor(() => bob.getState().issues.size === 1);
		expect(issueBy(bob, "Written in the follower").creatorId).toBe("alice");
		await waitForConvergence(follower, bob);
	});

	it("load a new tab from storage", async () => {
		workspace = new TestWorkspace();
		const network = workspace.network("alice");
		const openTab = opener(workspace, network);
		const leader = openTab();
		await waitForLive(leader);
		const team = make.team();
		await leader.mutate(team);
		await waitFor(() => leader.getStatus().pending === 0);

		const snapshots = network.snapshots;
		const later = openTab();
		await waitFor(() => later.getState().teams.has(team.args.id));
		expect(network.snapshots).toBe(snapshots);
	});
});
