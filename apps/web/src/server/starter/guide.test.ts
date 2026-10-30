import { mutationSchema } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { guideSteps, guideTeamId } from "./guide";

function steps(name = "Acme Inc.", mcpUrl: string | null = "https://track.example.com/mcp") {
	let next = 0;
	return guideSteps({
		workspace: { id: "ws-1", name },
		ownerId: "user-owner",
		mcpUrl,
		newId: () => `id-${++next}`,
	});
}

describe("guideSteps", () => {
	it("builds only mutations the protocol accepts", () => {
		for (const mutation of steps().mutations) {
			expect(mutationSchema.safeParse(mutation).success, JSON.stringify(mutation)).toBe(true);
		}
	});

	it("creates the team first, named after the workspace, with an id fixed per workspace", () => {
		const { teamKey, mutations } = steps();
		expect(teamKey).toBe("AI");
		expect(mutations[0]).toEqual({
			name: "team.create",
			args: { id: guideTeamId("ws-1"), key: "AI", name: "Acme Inc." },
		});
		expect(guideTeamId("ws-1")).toBe(guideTeamId("ws-1"));
		expect(guideTeamId("ws-1")).not.toBe(guideTeamId("ws-2"));
	});

	it("puts every issue in that team, assigned to the owner, in listed order", () => {
		const issues = steps().mutations.slice(1);
		expect(issues.length).toBeGreaterThan(3);
		const sortOrders: string[] = [];
		for (const mutation of issues) {
			if (mutation.name !== "issue.create") throw new Error(`Unexpected ${mutation.name}`);
			expect(mutation.args.teamId).toBe(guideTeamId("ws-1"));
			expect(mutation.args.assigneeId).toBe("user-owner");
			sortOrders.push(mutation.args.sortOrder);
		}
		expect([...sortOrders].sort()).toEqual(sortOrders);
		expect(new Set(sortOrders).size).toBe(sortOrders.length);
	});

	it("gives a key to names that suggest none, and keeps long names valid", () => {
		expect(steps("123").teamKey).toBe("TEAM");
		const long = steps("x".repeat(80)).mutations[0];
		expect(mutationSchema.safeParse(long).success).toBe(true);
	});

	it("tells how to connect an agent only where the server has an MCP endpoint", () => {
		const text = (mcpUrl: string | null) =>
			steps("Acme", mcpUrl)
				.mutations.map((mutation) =>
					mutation.name === "issue.create" ? (mutation.args.description ?? "") : "",
				)
				.join("\n");
		expect(text("https://track.example.com/mcp")).toContain(
			"claude mcp add --transport http gateweave-track https://track.example.com/mcp",
		);
		expect(text(null)).not.toContain("claude mcp add");
		expect(text(null)).toContain("BETTER_AUTH_URL");
	});
});
