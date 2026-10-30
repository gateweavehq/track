import { env } from "cloudflare:workers";
import { attachmentName, isFileId, isInlineType, MAX_FILE_BYTES } from "#/lib/attachments";
import { db, getAuth } from "./auth";
import { demoEnabled } from "./demo/mode";
import { findMembershipById } from "./workspaces";

const FILE_ROUTE = /^\/api\/files\/([^/]+)\/([^/]+)\/([^/]+)$/;

export function isFileRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/files/");
}

/**
 * Gateway to the files attached in workspaces, kept in R2 under `<workspaceId>/<fileId>/<name>`.
 * Only members of the workspace get past it, checked against D1 as the sync gateway does, and
 * everyone else gets the same 404 as a file that does not exist.
 *
 *   PUT  /api/files/:workspaceId/:fileId/:name  upload; the browser makes the id
 *   GET  /api/files/:workspaceId/:fileId/:name  the file, with ranges and revalidation
 *   HEAD /api/files/:workspaceId/:fileId/:name
 *
 * A file is never served as a page of this origin: only images, audio, video and plain text show
 * in place, and always under a sandboxing Content-Security-Policy; everything else downloads.
 */
export async function handleFileRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = FILE_ROUTE.exec(url.pathname);
	if (!match) return error(404, "Not found");
	const [, workspaceId, fileId, encodedName] = match as unknown as [string, string, string, string];
	const name = decoded(encodedName);
	if (!name || !isFileId(fileId) || attachmentName(name) !== name) return error(404, "Not found");

	const write = request.method === "PUT";
	if (!write && request.method !== "GET" && request.method !== "HEAD") {
		return error(405, "Method not allowed");
	}
	// Session cookies ride along on cross-site requests; only the app itself may upload.
	if (write && request.headers.get("Origin") !== url.origin)
		return error(403, "Cross-origin request");
	// Anyone can join the public demo, so it keeps no files.
	if (write && demoEnabled()) return error(403, "Attachments are turned off in the demo");

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");
	const membership = await findMembershipById(db, decoded(workspaceId) ?? "", session.user.id);
	if (!membership) return error(404, "Not found");

	const bucket = env.FILES;
	if (!bucket) return error(503, "File uploads are not set up on this deployment");
	const key = `${membership.workspaceId}/${fileId}/${name}`;
	if (write) return upload(request, bucket, key, session.user.id);
	return serve(request, bucket, key, name);
}

async function upload(
	request: Request,
	bucket: R2Bucket,
	key: string,
	userId: string,
): Promise<Response> {
	const length = Number(request.headers.get("Content-Length"));
	if (!request.body || !Number.isInteger(length) || length <= 0) {
		return error(411, "The file's length is needed");
	}
	if (length > MAX_FILE_BYTES) {
		return error(413, `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
	}
	// Ids are random, so one in use means a retry of an upload that went through, or a member
	// trying to replace someone else's file. Either way the file stays as it is.
	if (await bucket.head(key)) return error(409, "That file already exists");

	await bucket.put(key, request.body, {
		httpMetadata: { contentType: mediaType(request.headers.get("Content-Type")) },
		customMetadata: { uploadedBy: userId },
	});
	return Response.json({ size: length }, { status: 201 });
}

async function serve(
	request: Request,
	bucket: R2Bucket,
	key: string,
	name: string,
): Promise<Response> {
	if (request.method === "HEAD") {
		const object = await bucket.head(key);
		if (!object) return error(404, "Not found");
		const headers = fileHeaders(object, name);
		headers.set("Content-Length", String(object.size));
		return new Response(null, { headers });
	}
	const object = await bucket.get(key, { onlyIf: request.headers, range: request.headers });
	if (!object) return error(404, "Not found");
	const headers = fileHeaders(object, name);
	// Without a body, a precondition failed: the browser's copy is current.
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	const body = (object as R2ObjectBody).body;
	if (object.range && request.headers.has("Range")) {
		// Runtimes differ in which of these they leave out, so take the range apart loosely.
		const range: { offset?: number; length?: number; suffix?: number } = object.range;
		const start = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
		const end = range.length !== undefined ? start + range.length : object.size;
		headers.set("Content-Range", `bytes ${start}-${end - 1}/${object.size}`);
		headers.set("Content-Length", String(end - start));
		return new Response(body, { status: 206, headers });
	}
	headers.set("Content-Length", String(object.size));
	return new Response(body, { headers });
}

function fileHeaders(object: R2Object, name: string): Headers {
	const stored = object.httpMetadata?.contentType ?? "application/octet-stream";
	const inline = isInlineType(stored);
	const type = !inline
		? "application/octet-stream"
		: stored === "text/plain"
			? "text/plain; charset=utf-8"
			: stored;
	return new Headers({
		"Content-Type": type,
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		// The file is all a browser may load, and nothing in it runs.
		"Content-Security-Policy":
			"default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
		"X-Content-Type-Options": "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		// A file never changes under its id. Private: it is only for members.
		"Cache-Control": "private, max-age=31536000, immutable",
		"Accept-Ranges": "bytes",
		ETag: object.httpEtag,
	});
}

/** The declared type without parameters, or a download type when it is missing or malformed. */
function mediaType(header: string | null): string {
	const type = header?.split(";")[0]?.trim().toLowerCase() ?? "";
	return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(type) ? type : "application/octet-stream";
}

function asciiName(name: string): string {
	return name.replace(/[^\x20-\x7e]/g, "_");
}

function decoded(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}
