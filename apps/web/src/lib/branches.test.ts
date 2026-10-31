import { describe, expect, it } from "vitest";
import { branchName } from "./branches";

describe("branchName", () => {
	it("joins the lowercased key and a slug of the title", () => {
		expect(branchName("ENG-12", "Fix the login form!")).toBe("eng-12-fix-the-login-form");
		expect(branchName("DES-3", "Café menü: ışık & gölge")).toBe("des-3-cafe-menu-isik-golge");
	});

	it("keeps the title short and the name tidy", () => {
		const name = branchName("ENG-1", "A very long title that goes on and on about many things");
		expect(name).toBe("eng-1-a-very-long-title-that-goes-on-and-on");
		expect(branchName("ENG-1", "  ---  ")).toBe("eng-1");
		expect(branchName("ENG-1", "Ship it -")).toBe("eng-1-ship-it");
		expect(branchName("ENG-1", "x".repeat(50))).toBe(`eng-1-${"x".repeat(40)}`);
	});
});
