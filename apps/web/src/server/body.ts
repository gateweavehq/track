/** Stops at `max` bytes. With strict UTF-8, an invalid encoding also returns null. */
export async function readText(
	request: Request,
	max: number,
	strictUtf8 = false,
): Promise<string | null> {
	const declared = Number(request.headers.get("Content-Length"));
	if (declared > max) return null;
	if (!request.body) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: strictUtf8 }).decode(bytes);
	} catch {
		return null;
	}
}
