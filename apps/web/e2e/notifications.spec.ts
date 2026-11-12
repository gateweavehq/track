import { expect, test } from "./fixtures";
import { startWorkspace } from "./helpers";

test("a person chooses what reaches their inbox and their email", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings`);
	await page.getByRole("link", { name: "Notifications" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/settings/notifications$`));

	const settings = page.getByRole("list", { name: "Notification settings" });
	await expect(settings.getByRole("combobox", { name: "Assigned to you" })).toHaveValue("email");
	await expect(settings.getByRole("combobox", { name: "Status changes" })).toHaveValue("inbox");

	await settings.getByRole("combobox", { name: "Status changes" }).selectOption("off");
	await settings.getByRole("combobox", { name: "Comments" }).selectOption("inbox");
	await page.reload();
	await expect(settings.getByRole("combobox", { name: "Status changes" })).toHaveValue("off");
	await expect(settings.getByRole("combobox", { name: "Comments" })).toHaveValue("inbox");
	await expect(settings.getByRole("combobox", { name: "Assigned to you" })).toHaveValue("email");
});

test("a person turns push on and off in this browser", async ({ page }) => {
	// Headless Chromium has no push service and blocks notifications, so the browser's side is played
	// here: it allows them, and keeps its subscription across reloads as a browser does. The server's
	// side is real: it checks the subscription and saves it.
	await page.addInitScript(() => {
		Object.defineProperty(Notification, "permission", { get: () => "granted" });
		Notification.requestPermission = async () => "granted";
		const KEY = "e2e:push-subscription";
		const encode = (bytes: Uint8Array) =>
			btoa(String.fromCharCode(...bytes))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, "");
		const decode = (text: string) =>
			Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
		const restore = (): PushSubscription | null => {
			const saved = localStorage.getItem(KEY);
			if (!saved) return null;
			const { json, key } = JSON.parse(saved);
			return {
				endpoint: json.endpoint,
				options: { userVisibleOnly: true, applicationServerKey: decode(key).buffer },
				toJSON: () => json,
				unsubscribe: async () => {
					localStorage.removeItem(KEY);
					return true;
				},
			} as unknown as PushSubscription;
		};
		PushManager.prototype.getSubscription = async () => restore();
		PushManager.prototype.subscribe = async (options) => {
			const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
			const point = random(65);
			point[0] = 4;
			const json = {
				endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${encode(random(12))}`,
				expirationTime: null,
				keys: { p256dh: encode(point), auth: encode(random(16)) },
			};
			const key = encode(new Uint8Array(options?.applicationServerKey as ArrayBuffer));
			localStorage.setItem(KEY, JSON.stringify({ json, key }));
			return restore() as PushSubscription;
		};
	});

	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/notifications`);
	const push = page.getByRole("button", { name: "Turn on" });
	await expect(page.getByText("Push notifications on this device")).toBeVisible();
	await push.click();
	const off = page.getByRole("button", { name: "Turn off" });
	await expect(off).toBeVisible();

	// It is on only once the server saved it, and stays on when Track starts again and saves it again.
	await page.reload();
	await expect(off).toBeVisible();

	await off.click();
	await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
});
