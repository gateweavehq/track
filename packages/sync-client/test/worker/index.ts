import { MEMBER_HEADER, type MemberProfile } from "@tangent/sync-server";

export { WorkspaceDO } from "@tangent/sync-server";

const MEMBERS: Record<string, MemberProfile> = {
	alice: { id: "alice", name: "Alice", email: "alice@example.com", image: null, role: "owner" },
	bob: { id: "bob", name: "Bob", email: "bob@example.com", image: null, role: "member" },
};

/** Users removed from a workspace, as `workspace/user`. Memory is enough for one test run. */
const removed = new Set<string>();

const SYNC_ROUTE = /^\/as\/([^/]+)\/api\/sync\/([^/]+)\/(snapshot|socket)$/;
const REMOVE_ROUTE = /^\/admin\/([^/]+)\/remove\/([^/]+)$/;

/**
 * Stand-in for the app's sync gateway. Tests choose who they are with the `/as/:user` prefix
 * instead of a session cookie; everything after it matches the real gateway's routes.
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		const remove = REMOVE_ROUTE.exec(url.pathname);
		if (remove && request.method === "POST") {
			const [, workspace = "", user = ""] = remove;
			removed.add(`${workspace}/${user}`);
			await env.WORKSPACE.getByName(workspace).removeMember(user);
			return new Response(null, { status: 204 });
		}

		const match = SYNC_ROUTE.exec(url.pathname);
		if (!match) return new Response("Not found", { status: 404 });
		const [, user = "", workspace = "", endpoint] = match;
		const member = MEMBERS[user];
		if (!member) return new Response("Not signed in", { status: 401 });
		if (removed.has(`${workspace}/${user}`)) return new Response("Not found", { status: 404 });

		const stub = env.WORKSPACE.getByName(workspace);
		if (endpoint === "socket") {
			return stub.fetch("https://workspace/socket", {
				headers: { Upgrade: "websocket", [MEMBER_HEADER]: JSON.stringify(member) },
			});
		}
		if (request.method === "HEAD") return new Response(null, { status: 204 });
		return Response.json(await stub.snapshot(member));
	},
} satisfies ExportedHandler<Cloudflare.Env>;
