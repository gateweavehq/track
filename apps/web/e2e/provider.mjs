// Stands in for an OpenID Connect provider in the end-to-end tests. Its sign-in page is no page at
// all: `/authorize` answers at once, as whoever the browser's `e2e-person` cookie says, so tests
// running side by side cannot sign in as each other.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const PROVIDER_PORT = (Number(process.env.TRACK_E2E_PORT) || 4711) + 40;
const issuer = `http://localhost:${PROVIDER_PORT}`;
// Set for the build in vite.config.ts, whose values these have to match.
const credentials = Buffer.from("track-e2e:track-e2e-secret").toString("base64");

const keys = await generateKeyPair("ES256");
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "e2e", alg: "ES256", use: "sig" };
const codes = new Map();

function personIn(cookieHeader) {
	for (const cookie of (cookieHeader ?? "").split(";")) {
		const [name, value] = cookie.trim().split("=");
		if (name === "e2e-person" && value) return JSON.parse(decodeURIComponent(value));
	}
	return null;
}

function json(response, body, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

export const provider = createServer(async (request, response) => {
	const url = new URL(request.url, issuer);
	if (url.pathname === "/.well-known/openid-configuration") {
		json(response, {
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			jwks_uri: `${issuer}/jwks`,
			id_token_signing_alg_values_supported: ["ES256"],
		});
		return;
	}
	if (url.pathname === "/jwks") {
		json(response, { keys: [publicKey] });
		return;
	}
	if (url.pathname === "/authorize") {
		const person = personIn(request.headers.cookie);
		const back = new URL(url.searchParams.get("redirect_uri") ?? "");
		back.searchParams.set("state", url.searchParams.get("state") ?? "");
		back.searchParams.set("iss", issuer);
		if (!person || person.deny) {
			back.searchParams.set("error", "access_denied");
		} else {
			const code = randomBytes(16).toString("hex");
			codes.set(code, {
				person,
				nonce: url.searchParams.get("nonce"),
				challenge: url.searchParams.get("code_challenge"),
			});
			back.searchParams.set("code", code);
		}
		response.writeHead(302, { location: back.href });
		response.end();
		return;
	}
	if (url.pathname === "/token") {
		const form = new URLSearchParams(await readBody(request));
		const grant = codes.get(form.get("code"));
		const challenge = createHash("sha256")
			.update(form.get("code_verifier") ?? "")
			.digest("base64url");
		if (
			!grant ||
			request.headers.authorization !== `Basic ${credentials}` ||
			grant.challenge !== challenge
		) {
			json(response, { error: "invalid_grant" }, 400);
			return;
		}
		codes.delete(form.get("code"));
		const idToken = await new SignJWT({
			...grant.person,
			nonce: grant.nonce,
			sid: randomBytes(8).toString("hex"),
		})
			.setProtectedHeader({ alg: "ES256", kid: "e2e" })
			.setIssuer(issuer)
			.setAudience("track-e2e")
			.setIssuedAt()
			.setExpirationTime("5 minutes")
			.sign(keys.privateKey);
		json(response, {
			access_token: randomBytes(16).toString("hex"),
			token_type: "Bearer",
			expires_in: 3600,
			id_token: idToken,
		});
		return;
	}
	response.writeHead(404);
	response.end();
});
