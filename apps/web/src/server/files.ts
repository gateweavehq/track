import { env } from "cloudflare:workers";
import {
	attachmentName,
	attachmentPath,
	isFileId,
	isInlineType,
	MAX_FILE_BYTES,
} from "#/lib/attachments";
import { db, getAuth } from "./auth";
import { demoEnabled } from "./demo/mode";
import { releaseFileStorage, reserveFileStorage } from "./file-quota";
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
 *   PUT  /api/files/:workspaceId/:fileId/:name?upload=:token  an agent's upload, no session
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
	// Anyone can join the public demo, so it keeps no files.
	if (write && demoEnabled()) return error(403, "Attachments are turned off in the demo");
	// An upload address stands in for a session, so no cookie is read for it, and a session
	// never makes up for an address that fails.
	const token = write ? url.searchParams.get(UPLOAD_PARAM) : null;
	if (token !== null) {
		return uploadByAddress(request, token, {
			workspaceId: decoded(workspaceId) ?? "",
			fileId,
			name,
		});
	}
	// Session cookies ride along on cross-site requests; only the app itself may upload.
	if (write && request.headers.get("Origin") !== url.origin)
		return error(403, "Cross-origin request");

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");
	const membership = await findMembershipById(db, decoded(workspaceId) ?? "", session.user.id);
	if (!membership) return error(404, "Not found");

	const bucket = env.FILES;
	if (!bucket) return error(503, "File uploads are not set up on this deployment");
	const key = `${membership.workspaceId}/${fileId}/${name}`;
	if (write) {
		const type = mediaType(request.headers.get("Content-Type"));
		return upload(request, bucket, membership.workspaceId, key, session.user.id, type);
	}
	return serve(request, bucket, key, name);
}

async function upload(
	request: Request,
	bucket: R2Bucket,
	workspaceId: string,
	key: string,
	userId: string,
	type: string,
	size?: number,
): Promise<Response> {
	const length = Number(request.headers.get("Content-Length"));
	if (!request.body || !Number.isInteger(length) || length <= 0) {
		return error(411, "The file's length is needed");
	}
	if (size !== undefined && length !== size) {
		return error(400, `The upload address is for a file of ${size} bytes`);
	}
	if (length > MAX_FILE_BYTES) {
		return error(413, `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
	}
	// A retry sends the whole file again; when it is there already, say so before reading it.
	const existing = await bucket.head(key);
	if (existing) return taken(existing, userId);

	if (!(await reserveFileStorage(bucket, workspaceId, length))) {
		return error(
			413,
			"This workspace's files are full. Whoever runs this Track can raise its limit",
		);
	}
	let stored: R2Object | null;
	try {
		// The browser puts a file's link in the text before the upload ends, so other members can
		// see the id first. Only the first write stores anything, and R2 decides which was first.
		stored = await bucket.put(key, request.body, {
			onlyIf: new Headers({ "If-None-Match": "*" }),
			httpMetadata: { contentType: type },
			customMetadata: { uploadedBy: userId },
		});
	} catch (cause) {
		await releaseFileStorage(workspaceId, length);
		throw cause;
	}
	if (!stored) {
		await releaseFileStorage(workspaceId, length);
		const winner = await bucket.head(key);
		return winner ? taken(winner, userId) : error(503, "Try the upload again");
	}
	return Response.json({ size: length }, { status: 201 });
}

/**
 * An upload to an id in use. The file never changes under its link. When the uploader is the one
 * who stored it, this is a retry, or another tab, and 409 tells their browser it is there; when
 * someone else stored it, their browser must not take it for its own.
 */
function taken(object: R2Object, userId: string): Response {
	if (object.customMetadata?.uploadedBy === userId) return error(409, "That file already exists");
	return error(412, "Someone else's file is already at that link");
}

// Upload addresses. An agent working over MCP has no session, so `attach_file` hands it one
// address for one file: the file's path and a token, signed with the app's secret under a purpose
// of its own, that names the workspace, the file, its type and size, the member who asked and when
// it stops working. Whoever holds it may store that file once, while the member still belongs.

const UPLOAD_PARAM = "upload";
const UPLOAD_PURPOSE = "track-file-upload";
/** Long enough to make and send a large file, short enough that a leaked address soon goes. */
const UPLOAD_TTL_SECONDS = 10 * 60;

interface UploadFile {
	workspaceId: string;
	fileId: string;
	name: string;
}

interface UploadGrant extends UploadFile {
	type: string;
	size: number;
	userId: string;
	/** Seconds since the epoch. */
	expires: number;
}

export interface UploadAddress {
	/** The address to `PUT` the file's bytes to. */
	url: string;
	/** The file's path in the app, which the Markdown links. */
	path: string;
	/** The name and type the file is stored and served with. */
	name: string;
	type: string;
	expiresAt: number;
}

/**
 * An address a member may upload one new file to, without a session, for ten minutes. Null where
 * this deployment keeps no files. The caller has checked membership; the upload checks it again.
 */
export async function uploadAddress(
	origin: string,
	file: { workspaceId: string; userId: string; name: string; type: string; size: number },
	now = Date.now(),
): Promise<UploadAddress | null> {
	if (!env.FILES || demoEnabled()) return null;
	const grant: UploadGrant = {
		...file,
		fileId: crypto.randomUUID(),
		name: attachmentName(file.name),
		type: mediaType(file.type),
		expires: Math.floor(now / 1000) + UPLOAD_TTL_SECONDS,
	};
	const path = attachmentPath(grant.workspaceId, grant.fileId, grant.name);
	const token = await uploadToken(grant);
	return {
		url: `${origin}${path}?${UPLOAD_PARAM}=${token}`,
		path,
		name: grant.name,
		type: grant.type,
		expiresAt: grant.expires * 1000,
	};
}

async function uploadByAddress(
	request: Request,
	token: string,
	file: UploadFile,
): Promise<Response> {
	const grant = await readUploadToken(token);
	if (
		!grant ||
		grant.workspaceId !== file.workspaceId ||
		grant.fileId !== file.fileId ||
		grant.name !== file.name
	) {
		return error(403, "This upload address does not work. It may have expired");
	}
	// The member may have left, or been removed, since they asked.
	const membership = await findMembershipById(db, grant.workspaceId, grant.userId);
	if (!membership) return error(404, "Not found");
	const bucket = env.FILES;
	if (!bucket) return error(503, "File uploads are not set up on this deployment");
	const key = `${membership.workspaceId}/${grant.fileId}/${grant.name}`;
	return upload(request, bucket, membership.workspaceId, key, grant.userId, grant.type, grant.size);
}

async function uploadToken(grant: UploadGrant): Promise<string> {
	const payload = toBase64Url(
		new TextEncoder().encode(
			JSON.stringify([
				grant.workspaceId,
				grant.fileId,
				grant.name,
				grant.type,
				grant.size,
				grant.userId,
				grant.expires,
			]),
		),
	);
	const mac = await crypto.subtle.sign("HMAC", await uploadKey(), uploadMessage(payload));
	return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

async function readUploadToken(token: string): Promise<UploadGrant | null> {
	const [payload = "", signature = "", ...rest] = token.split(".");
	const mac = fromBase64Url(signature);
	const bytes = fromBase64Url(payload);
	if (rest.length > 0 || !mac || mac.length !== 32 || !bytes) return null;
	// `verify` compares in constant time.
	if (!(await crypto.subtle.verify("HMAC", await uploadKey(), mac, uploadMessage(payload)))) {
		return null;
	}
	let fields: unknown;
	try {
		fields = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	if (!Array.isArray(fields) || fields.length !== 7) return null;
	const [workspaceId, fileId, name, type, size, userId, expires] = fields as unknown[];
	if (
		typeof workspaceId !== "string" ||
		typeof fileId !== "string" ||
		typeof name !== "string" ||
		typeof type !== "string" ||
		typeof userId !== "string" ||
		!Number.isInteger(size) ||
		!Number.isInteger(expires) ||
		(expires as number) * 1000 <= Date.now()
	) {
		return null;
	}
	return {
		workspaceId,
		fileId,
		name,
		type,
		size: size as number,
		userId,
		expires: expires as number,
	};
}

/** A key of the app's secret for upload addresses alone, so no other token of it is one. */
async function uploadKey() {
	const secret = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(),
			info: new TextEncoder().encode(UPLOAD_PURPOSE),
		},
		secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function uploadMessage(payload: string) {
	return new TextEncoder().encode(`${UPLOAD_PURPOSE}:${payload}`);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const padded = value.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
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
/** A content type as the bucket keeps it: its media type alone, or a download when it is odd. */
export function mediaType(header: string | null): string {
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
