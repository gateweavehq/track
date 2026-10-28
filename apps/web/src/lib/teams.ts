/** A team key suggestion from its name: "Platform Engineering" becomes "PE", "Design" "DES". */
export function suggestKey(name: string): string {
	const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
	const key =
		words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "").slice(0, 3);
	return key.replace(/^[0-9]+/, "").slice(0, 7);
}
