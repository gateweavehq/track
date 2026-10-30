import { expect, newBrowserContext, test } from "./fixtures";
import { createIssue, signUp, startWorkspace, syncBadge, unique } from "./helpers";

// The smallest PNG there is: one transparent pixel.
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

test("descriptions and comments are Markdown, with files attached to them", async ({
	page,
	browser,
}) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Fix the export"));
	await page.goto(`/${slug}/issue/ENG-1`);

	// Written as Markdown, the description shows formatted once the editor closes.
	const description = page.getByRole("textbox", { name: "Description" });
	await description.fill("Steps:\n\n1. Open **settings**\n2. Press `Export`\n");
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Attach files to the description" }).click();
	await (await chooser).setFiles({
		name: "broken export.png",
		mimeType: "image/png",
		buffer: PIXEL,
	});
	await expect(page.getByText("Attached broken export.png")).toBeVisible();
	await expect(description).toHaveValue(
		/!\[broken export\.png\]\(\/api\/files\/.+\/broken%20export\.png\)/,
	);
	await description.press("Escape");

	await expect(page.locator("strong", { hasText: "settings" })).toBeVisible();
	await expect(page.locator("code", { hasText: "Export" })).toBeVisible();
	const image = page.getByRole("img", { name: "broken export.png" });
	await expect(image).toBeVisible();
	await expect
		.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
		.toBe(1);
	const imageUrl = new URL((await image.getAttribute("src")) ?? "", page.url()).toString();

	// The edit button, or a click in the text, opens the editor again.
	await page.getByRole("button", { name: "Edit description" }).click();
	await expect(description).toBeFocused();
	await description.press("Escape");

	// A comment takes a file the same way, and links what is not an image.
	const comment = page.getByRole("textbox", { name: "Comment", exact: true });
	await comment.fill("Logs from **today**:");
	const commentChooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Attach files to the comment" }).click();
	await (await commentChooser).setFiles({
		name: "export.log",
		mimeType: "text/plain",
		buffer: Buffer.from("error: the export timed out\n"),
	});
	await expect(page.getByText("Attached export.log")).toBeVisible();
	await page.getByRole("button", { name: "Comment", exact: true }).click();
	const posted = page.getByRole("article", { name: /^Comment by/ });
	await expect(posted.locator("strong", { hasText: "today" })).toBeVisible();
	const log = posted.getByRole("link", { name: "export.log" });
	await expect(log).toHaveAttribute("target", "_blank");
	const logUrl = new URL((await log.getAttribute("href")) ?? "", page.url());
	const logResponse = await page.request.get(logUrl.toString());
	expect(await logResponse.text()).toBe("error: the export timed out\n");
	await expect(syncBadge(page)).toHaveText("Live");

	// Someone outside the workspace cannot open its files, even with the link.
	const outsiderContext = await newBrowserContext(browser);
	try {
		const outsider = await outsiderContext.newPage();
		await signUp(outsider);
		expect((await outsider.request.get(imageUrl)).status()).toBe(404);
	} finally {
		await outsiderContext.close();
	}
});
