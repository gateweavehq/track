import type { DigestItem } from "@gateweave/track-sync-server";
import { expect, it, vi } from "vitest";
import { pushMessage } from "./index";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("../auth", () => ({ db: {}, getAuth: vi.fn() }));

it("R13: identifies the agent whose comment is quoted in a push notification", async () => {
	const item: DigestItem = {
		issue: { key: "ENG-1", title: "Export to PDF" },
		event: { type: "comment", commentId: "comment-1" },
		actor: "Triage",
		actorIsAgent: true,
		unread: 1,
		updatedAt: 0,
		comment: "I can take this.",
		statusName: null,
	};
	const agent = await pushMessage("ws-1", "acme", item);
	const person = await pushMessage("ws-1", "acme", { ...item, actorIsAgent: false });
	expect(JSON.parse(agent.text)).toMatchObject({
		body: "Triage (agent) commented on ENG-1\nI can take this.",
	});
	expect(JSON.parse(person.text)).toMatchObject({
		body: "Triage commented on ENG-1\nI can take this.",
	});
});
