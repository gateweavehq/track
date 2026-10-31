import { describe, expect, it } from "vitest";
import {
	type DigestEntry,
	inboxDigestEmail,
	invitationEmail,
	passwordResetEmail,
	verificationEmail,
} from "./templates";

const DAY = 24 * 60 * 60 * 1000;

describe("invitationEmail", () => {
	const now = Date.UTC(2026, 9, 28);
	const base = {
		inviter: { name: "Maya Chen", email: "maya@example.com" },
		workspace: "Acme",
		url: "https://track.example.com/invite/abc?x=1&y=2",
		expiresAt: now + 7 * DAY,
		now,
	};

	it("says who invited whom to what, and links to the invitation", () => {
		const email = invitationEmail(base);
		expect(email.subject).toBe("Maya Chen invited you to Acme on Gateweave Track");
		expect(email.text).toContain("Maya Chen (maya@example.com)");
		expect(email.text).toContain(base.url);
		expect(email.text).toContain("expires in 7 days");
		expect(email.html).toContain('href="https://track.example.com/invite/abc?x=1&amp;y=2"');
	});

	it("escapes names in HTML and keeps them to one short line", () => {
		const email = invitationEmail({
			...base,
			inviter: { name: "Mallory\r\nBcc: everyone", email: "m@example.com" },
			workspace: `<img src=x onerror=alert(1)> ${"very ".repeat(30)}long`,
		});
		expect(email.subject).not.toMatch(/[\r\n]/);
		expect(email.subject).toContain("Mallory Bcc: everyone invited you to");
		expect(email.subject).toContain("…");
		expect(email.html).not.toContain("<img");
		expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("counts down to a day, never zero", () => {
		const email = invitationEmail({ ...base, expiresAt: now + 3 * 60 * 60 * 1000 });
		expect(email.text).toContain("expires in 1 day.");
	});
});

describe("passwordResetEmail", () => {
	it("links to the reset and says what happens", () => {
		const url = "https://track.example.com/api/auth/reset-password/token?callbackURL=%2Freset";
		const email = passwordResetEmail({ url });
		expect(email.subject).toBe("Reset your Gateweave Track password");
		expect(email.text).toContain(url);
		expect(email.text).toContain("signs you out on every device");
		expect(email.html).toContain(`href="${url}"`);
	});
});

describe("verificationEmail", () => {
	it("links to the verification and says how long it works", () => {
		const url = "https://track.example.com/api/auth/verify-email?token=t&callbackURL=%2F";
		const email = verificationEmail({ url });
		expect(email.subject).toBe("Verify your email for Gateweave Track");
		expect(email.text).toContain(url);
		expect(email.text).toContain("24 hours");
		expect(email.html).toContain(`href="${url.replace("&", "&amp;")}"`);
	});
});

describe("inboxDigestEmail", () => {
	const entry: DigestEntry = {
		key: "ENG-12",
		title: "Export issues as CSV",
		url: "https://track.example.com/acme/issue/ENG-12",
		event: { type: "assigned" },
		actor: "Maya Chen",
		unread: 1,
		comment: null,
	};
	const base = {
		workspace: "Acme",
		inboxUrl: "https://track.example.com/acme/inbox",
		settingsUrl: "https://track.example.com/acme/settings/notifications",
	};

	it("names the one piece of news in the subject, and links to the issue and the settings", () => {
		const email = inboxDigestEmail({ ...base, items: [entry] });
		expect(email.subject).toBe("Maya Chen assigned you ENG-12: Export issues as CSV");
		expect(email.text).toContain("ENG-12 Export issues as CSV\nMaya Chen assigned you ENG-12");
		expect(email.text).toContain(entry.url);
		expect(email.text).toContain(`notification settings: ${base.settingsUrl}`);
		expect(email.html).toContain(`href="${entry.url}"`);
		expect(email.html).toContain(`href="${base.inboxUrl}"`);
		expect(email.html).toContain(`href="${base.settingsUrl}"`);
	});

	it("counts the news, and says what each was", () => {
		const email = inboxDigestEmail({
			...base,
			items: [
				{ ...entry, event: { type: "comment", commentId: "c1" }, comment: "Ship it", unread: 3 },
				{ ...entry, key: "ENG-13", event: { type: "status", from: "todo", to: "in_review" } },
				{ ...entry, key: "ENG-14", event: { type: "unassigned" } },
				{
					...entry,
					key: "ENG-15",
					actor: "Triage",
					event: { type: "proposal", proposalId: "p1", change: { type: "priority", to: 1 } },
				},
			],
		});
		expect(email.subject).toBe("4 updates in Acme");
		expect(email.text).toContain("Maya Chen commented on ENG-12 · 3 updates\n> Ship it");
		expect(email.text).toContain("Maya Chen moved ENG-13 to In Review");
		expect(email.text).toContain("Maya Chen unassigned you from ENG-14");
		expect(email.text).toContain("Triage proposed a change to ENG-15");
	});

	it("escapes what members typed, and keeps it short", () => {
		const email = inboxDigestEmail({
			...base,
			workspace: "Acme\r\nBcc: everyone",
			items: [
				{
					...entry,
					title: "<script>alert(1)</script>",
					event: { type: "comment", commentId: "c1" },
					comment: `<img src=x> ${"word ".repeat(100)}`,
				},
			],
		});
		expect(email.subject).not.toMatch(/[\r\n]/);
		expect(email.html).not.toContain("<script>");
		expect(email.html).not.toContain("<img src=x>");
		expect(email.html).toContain("&lt;script&gt;");
		const quote = email.text.split("\n").find((line) => line.startsWith("> "));
		expect(quote?.length).toBeLessThanOrEqual(282);
		expect(quote?.endsWith("…")).toBe(true);
	});
});
