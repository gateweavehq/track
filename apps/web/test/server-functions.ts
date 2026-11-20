import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
function serverFnUrl(origin: string, name: string) {
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const id = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!id) throw new Error(`No server function ${name} in the build`);
	return `${origin}/_serverFn/${id}`;
}

let nodes = 0;
/** A value as Seroval's JSON, for strings, null, booleans, numbers and plain objects. */
function encode(value: unknown): unknown {
	if (value === null) return { t: 2, s: 0 };
	if (typeof value === "string") return { t: 1, s: value };
	if (typeof value === "number") return { t: 0, s: value };
	if (typeof value === "boolean") return { t: 2, s: value ? 2 : 3 };
	if (Array.isArray(value)) return { t: 9, i: ++nodes, a: value.map(encode) };
	const entries = Object.entries(value as object);
	return {
		t: 10,
		i: ++nodes,
		p: { k: entries.map(([key]) => key), v: entries.map(([, each]) => encode(each)) },
		o: 0,
	};
}

/** Reads the plain values of Seroval's JSON. */
function decode(node: unknown): unknown {
	const { t, s, a, p } = node as {
		t: number;
		s?: unknown;
		a?: unknown[];
		p?: { k: string[]; v: unknown[] };
	};
	switch (t) {
		case 0:
		case 1:
			return s;
		case 2:
			return [null, undefined, true, false][s as number];
		case 9:
			return (a ?? []).map(decode);
		case 10:
			return Object.fromEntries((p?.k ?? []).map((key, i) => [key, decode(p?.v[i])]));
		default:
			throw new Error(`Unexpected node type ${t}`);
	}
}

export function serverFunctions(origin: string, request: typeof fetch, address: () => string) {
	return async function serverFn<T>(
		name: string,
		method: "GET" | "POST",
		data: unknown,
		{ cookie, from = origin }: { cookie?: string; from?: string | null } = {},
	): Promise<{ text: string; result: T; status: number; headers: Headers }> {
		const body = JSON.stringify({ t: encode({ data }), f: 0, m: [] });
		const url =
			method === "GET"
				? `${serverFnUrl(origin, name)}?payload=${encodeURIComponent(body)}`
				: serverFnUrl(origin, name);
		const response = await request(url, {
			method,
			headers: {
				"x-tsr-serverFn": "true",
				accept: "application/json",
				"cf-connecting-ip": address(),
				...(from && { origin: from }),
				...(cookie && { cookie }),
				...(method === "POST" && { "content-type": "application/json" }),
			},
			...(method === "POST" && { body }),
		});
		const text = await response.text();
		const json = response.headers.get("content-type")?.includes("json");
		const { result } = (json ? decode(JSON.parse(text)) : { result: undefined }) as { result: T };
		return { text, result, status: response.status, headers: response.headers };
	};
}
