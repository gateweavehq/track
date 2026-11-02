// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachFiles } from "./attach-files";

// Attaching files where some links hold someone else's file (412): each such file's copy is
// offered, however many there are and whether or not the browser thought it was online (TRK-70).
// The outbox and its uploads are real; the gateway is a stand-in fetch, the toasts a record.

interface Shown {
	kind: "plain" | "error" | "promise";
	message: string;
	action?: { label: string };
}

const { shown, promises } = vi.hoisted(() => ({
	shown: [] as Shown[],
	promises: [] as Promise<void>[],
}));

vi.mock("sonner", () => {
	const record =
		(kind: Shown["kind"]) => (message: string, options?: { action?: { label: string } }) => {
			shown.push({ kind, message, ...(options?.action && { action: options.action }) });
		};
	const toast = Object.assign(record("plain"), {
		error: record("error"),
		promise: (
			promise: Promise<unknown>,
			options: { error: (error: unknown) => { message: string; action?: { label: string } } },
		) => {
			promises.push(
				promise.then(
					() => {},
					(error: unknown) => {
						const { message, action } = options.error(error);
						shown.push({ kind: "promise", message, ...(action && { action }) });
					},
				),
			);
		},
	});
	return { toast };
});

vi.mock("#/components/workspace/context", () => ({
	useWorkspace: () => ({ id: "ws-1", userId: "user-1", demo: false }),
}));

/** Answers each upload by the file's name: "taken" ones 412, "big" ones 413, the rest 201. */
function gateway() {
	return vi.fn(async (input: RequestInfo | URL) => {
		const name = String(input).split("/").at(-1) ?? "";
		const status = name.startsWith("taken") ? 412 : name.startsWith("big") ? 413 : 201;
		const body = status >= 400 ? JSON.stringify({ error: `Refused ${name}` }) : null;
		return new Response(body, { status });
	});
}

function attachHook() {
	const textarea = document.createElement("textarea");
	const { result } = renderHook(() => useAttachFiles({ current: textarea }, () => {}));
	const attach = result.current?.attach;
	if (!attach) throw new Error("No attach");
	return attach;
}

const file = (name: string) => new File([name], name, { type: "text/plain" });

/** Waits until every upload settled and every toast for it is up. */
async function settled(count: number) {
	await vi.waitFor(() => {
		expect(shown.filter((each) => each.kind !== "plain").length).toBeGreaterThanOrEqual(count);
	});
	await Promise.all(promises);
}

let online = true;

beforeEach(() => {
	shown.length = 0;
	promises.length = 0;
	online = true;
	vi.stubGlobal("fetch", gateway());
	vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("attaching files", () => {
	it("offers a copy of every file whose link was taken, not only the first refused", async () => {
		const attach = attachHook();
		attach([file("big.txt"), file("taken-one.txt"), file("fine.txt"), file("taken-two.txt")]);
		await settled(3);

		const save = (each: Shown) => each.action?.label === "Save a copy";
		// The first refusal, the one too large, is the batch's own toast, with nothing to save.
		expect(shown.find((each) => each.kind === "promise")).toEqual({
			kind: "promise",
			message: "Could not attach the file",
		});
		expect(shown.filter(save).map((each) => each.message)).toEqual([
			"Could not attach taken-one.txt",
			"Could not attach taken-two.txt",
		]);
	});

	it("offers the copy when the browser said it was offline and the upload got through", async () => {
		online = false;
		const attach = attachHook();
		attach([file("taken-offline.txt"), file("fine-offline.txt")]);
		await settled(1);

		expect(shown[0]).toMatchObject({
			kind: "plain",
			message: "2 files will upload when you are back online",
		});
		expect(shown.slice(1)).toEqual([
			{
				kind: "error",
				message: "Could not attach taken-offline.txt",
				action: expect.objectContaining({ label: "Save a copy" }),
			},
		]);
	});
});
