// Where a text box draws its caret. Browsers do not say, so a hidden copy of the box, styled the
// same and holding the text up to the caret, is measured instead.

const COPIED = [
	"boxSizing",
	"width",
	"borderTopWidth",
	"borderRightWidth",
	"borderBottomWidth",
	"borderLeftWidth",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
	"fontFamily",
	"fontSize",
	"fontStyle",
	"fontVariant",
	"fontWeight",
	"fontStretch",
	"lineHeight",
	"letterSpacing",
	"wordSpacing",
	"tabSize",
	"textAlign",
	"textIndent",
	"textTransform",
] as const;

/**
 * Where the caret at `position` is in a text box: the top-left of its line, from the box's own
 * top-left corner, in pixels, and the line's height.
 */
export function caretOffset(
	element: HTMLTextAreaElement,
	position: number,
): { top: number; left: number; height: number } {
	const style = getComputedStyle(element);
	const copy = document.createElement("div");
	for (const property of COPIED) copy.style[property] = style[property];
	Object.assign(copy.style, {
		position: "absolute",
		top: "0",
		left: "-9999px",
		visibility: "hidden",
		overflow: "hidden",
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
	});
	copy.textContent = element.value.slice(0, position);
	const marker = document.createElement("span");
	// The rest of the text wraps the caret's line as the box does.
	marker.textContent = element.value.slice(position) || ".";
	copy.appendChild(marker);
	document.body.appendChild(copy);
	const fontSize = Number.parseFloat(style.fontSize) || 14;
	const offset = {
		top: marker.offsetTop + Number.parseFloat(style.borderTopWidth) - element.scrollTop,
		left: marker.offsetLeft + Number.parseFloat(style.borderLeftWidth) - element.scrollLeft,
		height: Number.parseFloat(style.lineHeight) || fontSize * 1.4,
	};
	copy.remove();
	return offset;
}
