// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	slug: "first",
	workspace: { id: "one", userId: "person" },
	client: null as object | null,
	pairs: [] as { key: string; client: object | null }[],
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({
		...options,
		useParams: () => ({ workspace: state.slug }),
		useLoaderData: () => state.workspace,
	}),
	Link: () => null,
	Outlet: () => null,
	notFound: () => new Error("not found"),
	redirect: () => new Error("redirect"),
}));
vi.mock("@gateweave/track-sync-client", () => ({
	createBrowserSyncClient: () => ({
		close: async () => {},
		subscribeStatus: () => () => {},
		getStatus: () => ({ connection: "connecting" }),
	}),
}));
vi.mock("@gateweave/track-sync-client/react", () => ({
	SyncProvider: ({ client, children }: { client: object; children: React.ReactNode }) => {
		state.client = client;
		return children;
	},
}));
vi.mock("#/components/workspace/context", () => ({
	WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("#/components/workspace/actions", () => ({
	WorkspaceActionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("#/components/workspace/app-shell", () => ({
	AppShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("#/components/workspace/sync-status", () => ({
	SyncGate: ({ storageKey, children }: { storageKey: string; children: React.ReactNode }) => {
		state.pairs.push({ key: storageKey, client: state.client });
		return children;
	},
}));
vi.mock("#/lib/replica", () => ({
	replicaKey: (userId: string, workspaceId: string) => `${userId}:${workspaceId}`,
	forgetWorkspace: async () => {},
}));

import { Route } from "./$workspace";

// The layout is reached through the route, not exported: an export from a route file is left
// out of the route's code-split chunk.
const WorkspaceLayout = (Route as unknown as { component: () => React.ReactNode }).component;

afterEach(() => {
	cleanup();
	state.slug = "first";
	state.workspace = { id: "one", userId: "person" };
	state.client = null;
	state.pairs = [];
});

it("never renders a new workspace key with the previous client's provider", () => {
	const page = render(<WorkspaceLayout />);
	const first = state.pairs.at(-1)?.client;
	expect(first).toBeTruthy();
	state.slug = "second";
	state.workspace = { id: "two", userId: "person" };
	page.rerender(<WorkspaceLayout />);
	expect(state.pairs.filter(({ key }) => key === "person:two")).toHaveLength(1);
	expect(state.pairs.at(-1)?.client).not.toBe(first);
});
