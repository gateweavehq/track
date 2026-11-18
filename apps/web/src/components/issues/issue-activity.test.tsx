// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CommentEditDescription } from "./issue-activity";

afterEach(cleanup);

it("renders the first previous text and its truncation mark in comment history", () => {
	const html = renderToStaticMarkup(
		<CommentEditDescription from="Original text\n\n[… truncated]" />,
	);
	expect(html).toContain("edited a comment");
	expect(html).toContain("Original text");
	expect(html).toContain("[… truncated]");
});

it("shows the previous text from a button, not only on hover", () => {
	const page = render(<CommentEditDescription from="Original text" />);
	const button = page.getByRole("button", { name: "Show the previous text" });
	expect(button.getAttribute("aria-expanded")).toBe("false");
	const previous = page.getByText("Original text");
	expect(previous.hidden).toBe(true);
	expect(button.getAttribute("aria-controls")).toBe(previous.id);
	fireEvent.click(button);
	expect(
		page.getByRole("button", { name: "Hide the previous text" }).getAttribute("aria-expanded"),
	).toBe("true");
	expect(previous.hidden).toBe(false);
	expect(previous.closest("[title]")).toBeNull();
});
