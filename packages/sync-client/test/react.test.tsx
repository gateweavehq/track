// @vitest-environment happy-dom
import type { Snapshot } from "@gateweave/track-protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SyncClient, type SyncState, type Transport } from "../src";
import { SyncProvider, shallowEqual, useQuery, useSyncStatus } from "../src/react";
import { make, waitFor } from "./harness";

const snapshot: Snapshot = {
	version: 1,
	teams: [{ id: "t1", key: "ENG", name: "Engineering", cycles: null, createdAt: 1, updatedAt: 1 }],
	issues: [],
	labels: [],
	projects: [],
	cycles: [],
	comments: [],
	activities: [],
	proposals: [],
	relations: [],
	views: [],
	members: [],
};

/** Serves a snapshot but never connects, so every mutation stays pending. */
const offline: Transport = {
	snapshot: async () => snapshot,
	probe: async () => {},
	connect: () => ({ send() {}, close() {} }),
};

let client: SyncClient;

afterEach(async () => {
	cleanup();
	await client?.close();
});

async function setup() {
	client = new SyncClient({ userId: "alice", transport: offline });
	await waitFor(() => client.getStatus().loaded);
	return client;
}

const selectTitles = (state: SyncState) => [...state.issues.values()].map((i) => i.title);
const selectTeams = (state: SyncState) => [...state.teams.values()];

function Issues() {
	const titles = useQuery(selectTitles, shallowEqual);
	const { pending } = useSyncStatus();
	return (
		<p>
			{titles.join(", ") || "none"} ({pending} pending)
		</p>
	);
}

let teamRenders = 0;

function Teams() {
	teamRenders += 1;
	const teams = useQuery(selectTeams, shallowEqual);
	return <p>{teams.length} teams</p>;
}

it("re-renders with local changes", async () => {
	await setup();
	render(
		<SyncProvider client={client}>
			<Issues />
		</SyncProvider>,
	);
	expect(screen.getByText("none (0 pending)")).toBeTruthy();

	act(() => void client.mutate(make.issue("t1", "Ship it")));
	expect(screen.getByText("Ship it (1 pending)")).toBeTruthy();
});

it("skips renders when the selection is unchanged", async () => {
	await setup();
	render(
		<SyncProvider client={client}>
			<Teams />
		</SyncProvider>,
	);
	const before = teamRenders;

	act(() => void client.mutate(make.issue("t1", "Unrelated")));
	expect(teamRenders).toBe(before);

	act(() => void client.mutate(make.team("OPS", "Operations")));
	expect(teamRenders).toBe(before + 1);
	expect(screen.getByText("2 teams")).toBeTruthy();
});
