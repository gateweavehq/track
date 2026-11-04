import { PROTOCOL_VERSION } from "@gateweave/track-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	browserTabs,
	HttpError,
	openIdbPersistence,
	supportsBrowserTabs,
	type Transport,
	tabsName,
} from "../src";
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
			tabs: browserTabs(tabsName(key)),
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

		// So does a batch, mutation by mutation.
		const batch = follower.mutateAll([
			make.issue(team.args.id, "Batch one"),
			make.issue(team.args.id, "Batch two"),
		]);
		await waitFor(() => leader.getState().issues.size === 2);
		await Promise.all(batch);
		await waitForConvergence(leader, follower);

		// Other users' changes reach the follower through the leader.
		const bob = await workspace.live("bob");
		await bob.mutate(make.issue(team.args.id, "From Bob"));
		await waitFor(() => follower.getState().issues.size === 3);
		expect(issueBy(follower, "From Bob")).toEqual(issueBy(leader, "From Bob"));
		expect(network.connects).toBe(1);
	});

	it("never wait for a tab left open on the protocol version before an update", async () => {
		workspace = new TestWorkspace();
		const network = workspace.network("alice");
		const key = `tabs-${workspace.id}`;
		// The old tab leads its own version's tabs until it is reloaded, and answers none of ours.
		let releaseOld = () => {};
		const held = new Promise<void>((resolve) => {
			void navigator.locks.request(tabsName(key, PROTOCOL_VERSION - 1), () => {
				resolve();
				return new Promise<void>((release) => {
					releaseOld = release;
				});
			});
		});
		await held;

		const tab = opener(workspace, network)();
		await waitForLive(tab);
		expect(tab.getStatus().loaded).toBe(true);
		expect(network.connects).toBe(1);
		releaseOld();
	});

	it("wake a leader left signed out, as a new tab means someone has signed in", async () => {
		workspace = new TestWorkspace();
		const network = workspace.network("alice");
		const key = `tabs-${workspace.id}`;
		let signedIn = true;
		const transport: Transport = {
			...network.transport,
			probe: async () => {
				if (!signedIn) throw new HttpError(401);
				return network.transport.probe();
			},
		};
		const openTab = () =>
			workspace.client("alice", {
				transport,
				persistence: openIdbPersistence(key),
				tabs: browserTabs(tabsName(key)),
			});
		const leader = openTab();
		await waitForLive(leader);

		// Its session ends. Sockets go, and the probe says why.
		signedIn = false;
		network.offline();
		await waitFor(() => leader.getStatus().connection === "unauthorized");
		const connects = network.connects;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(network.connects).toBe(connects);

		// A tab that opens with nobody signed in hears so, and the leader goes back to asking.
		const early = openTab();
		await waitFor(() => network.connects > connects);
		await waitFor(() => leader.getStatus().connection === "unauthorized");
		await waitFor(() => early.getStatus().connection === "unauthorized");
		await early.close();

		// Signed in again, the next tab gets the workspace, and so does the one that was asking.
		signedIn = true;
		network.online();
		const late = openTab();
		await waitFor(() => leader.getStatus().connection === "live");
		await waitFor(() => late.getStatus().connection === "live");
		expect(network.sockets).toBe(1);
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
