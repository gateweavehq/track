import type { SavedView } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { canEditView, compareViews, isViewVisible } from "./saved-views";

const view = (patch: Partial<SavedView>): SavedView => ({
	id: "v1",
	name: "Bugs",
	ownerId: null,
	layout: "list",
	filters: {},
	creatorId: "maya",
	createdAt: 1,
	updatedAt: 1,
	...patch,
});

describe("saved views", () => {
	it("shows shared views to everyone and personal ones to their owner only", () => {
		expect(isViewVisible(view({}), "sam")).toBe(true);
		expect(isViewVisible(view({ ownerId: "maya" }), "maya")).toBe(true);
		expect(isViewVisible(view({ ownerId: "maya" }), "sam")).toBe(false);
	});

	it("lets the creator and admins change a shared view, and only the owner a personal one", () => {
		const shared = view({});
		expect(canEditView(shared, "maya", "member")).toBe(true);
		expect(canEditView(shared, "sam", "admin")).toBe(true);
		expect(canEditView(shared, "lena", "member")).toBe(false);
		expect(canEditView(shared, "bot", "agent")).toBe(false);
		const personal = view({ ownerId: "lena", creatorId: "lena" });
		expect(canEditView(personal, "lena", "member")).toBe(true);
		expect(canEditView(personal, "maya", "owner")).toBe(false);
	});

	it("lists shared views first, then personal ones, each by name", () => {
		const views = [
			view({ id: "a", name: "zeta", ownerId: "maya" }),
			view({ id: "b", name: "Beta" }),
			view({ id: "c", name: "alpha", ownerId: "maya" }),
			view({ id: "d", name: "Issue 10" }),
			view({ id: "e", name: "Issue 9" }),
		];
		expect(views.sort(compareViews).map((v) => v.name)).toEqual([
			"Beta",
			"Issue 9",
			"Issue 10",
			"alpha",
			"zeta",
		]);
	});
});
