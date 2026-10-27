/**
 * Generates a UUIDv7 (RFC 9562): a millisecond timestamp followed by random bits. Ids made this
 * way sort by creation time, which keeps database indexes compact. Use it for new entity ids.
 */
export function uuidv7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const now = Date.now();
	for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
