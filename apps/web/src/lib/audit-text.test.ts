import type { AuditEvent } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { auditActor, auditSentence } from "./audit-text";

const people = {
	"user-ola": { name: "Ola", image: null, agent: false },
	"user-mo": { name: "Mo", image: null, agent: false },
	"agent-bot": { name: "Triage bot", image: null, agent: true },
};

function event(fields: Partial<AuditEvent> & Pick<AuditEvent, "action">): AuditEvent {
	return {
		id: 1,
		at: 0,
		actorId: "user-ola",
		target: { type: "workspace", id: null, label: null },
		detail: {},
		...fields,
	};
}

describe("audit events in words", () => {
	it("names who did it, or says it was Track or someone no longer known", () => {
		expect(auditActor(event({ action: "member.left" }), people)).toBe("Ola");
		expect(auditActor(event({ action: "member.left", actorId: null }), people)).toBe("Track");
		expect(auditActor(event({ action: "member.left", actorId: "user-gone" }), people)).toBe(
			"Someone",
		);
	});

	it("says what was done to whom", () => {
		const say = (fields: Parameters<typeof event>[0]) => auditSentence(event(fields), people);
		expect(
			say({
				action: "invitation.created",
				target: { type: "invitation", id: "inv-1", label: "bo@example.com" },
				detail: { role: "admin" },
			}),
		).toBe("invited bo@example.com as an admin");
		expect(
			say({
				action: "invitation.canceled",
				target: { type: "invitation", id: "inv-1", label: null },
			}),
		).toBe("revoked the invitation to an address since forgotten");
		expect(
			say({
				action: "member.roleChanged",
				target: { type: "member", id: "user-mo", label: null },
				detail: { from: "member", to: "admin" },
			}),
		).toBe("changed Mo's role from member to admin");
		expect(
			say({
				action: "agent.updated",
				target: { type: "agent", id: "agent-bot", label: "Triage bot" },
				detail: { from: [], to: ["title", "status", "close"] },
			}),
		).toBe("had the agent Triage bot propose changes to titles, statuses and closing");
		expect(
			say({
				action: "team.updated",
				target: { type: "team", id: "team-1", label: "Engineering" },
				detail: { change: "intakeForm", to: "renewed" },
			}),
		).toBe("gave Engineering's request form a new link");
		expect(
			say({
				action: "comment.deleted",
				target: { type: "comment", id: "c-1", label: "ENG-12" },
				detail: { author: "user-mo" },
			}),
		).toBe("deleted a comment by Mo on ENG-12");
		expect(
			say({
				action: "webhook.updated",
				target: { type: "webhook", id: "w-1", label: "hooks.example.com" },
				detail: { change: "active", to: false },
			}),
		).toBe("paused the webhook to hooks.example.com");
		expect(
			say({
				action: "workspace.updated",
				target: { type: "workspace", id: "ws-1", label: "Acme" },
				detail: { name: "Acme", previousName: "Acme Inc", slug: "acme" },
			}),
		).toBe("renamed the workspace from Acme Inc to Acme and moved the workspace to /acme");
	});
});
