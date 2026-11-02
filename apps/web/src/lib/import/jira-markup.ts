// Jira writes descriptions and comments in its own wiki markup, and its CSV export keeps it:
// `h2. Steps`, `*bold*`, `{code:java}`, `||a||b||` tables, `[text|url]` links. Track shows
// Markdown, so an import turns the common parts into Markdown and leaves the rest as text.
// Attachments stay in Jira: an embedded image becomes a note naming its file.

/** Jira wiki markup as Markdown. Text inside code blocks and `{{monospace}}` is left alone. */
export function jiraToMarkdown(text: string): string {
	const out: string[] = [];
	let fence: "code" | "noformat" | null = null;
	let quote = false;
	let tableHeader = false;
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (fence) {
			const close = `{${fence}}`;
			const end = line.indexOf(close);
			if (end < 0) {
				out.push(line);
				continue;
			}
			if (end > 0) out.push(line.slice(0, end));
			out.push("```");
			fence = null;
			const rest = line.slice(end + close.length).trim();
			if (rest) out.push(convertLine(rest));
			continue;
		}
		const open = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/.exec(line);
		if (open) {
			const kind = open[1] as "code" | "noformat";
			const language = kind === "code" ? languageOf(open[2] ?? "") : "";
			out.push(`\`\`\`${language}`);
			const rest = open[3] ?? "";
			const end = rest.indexOf(`{${kind}}`);
			if (end >= 0) {
				if (end > 0) out.push(rest.slice(0, end));
				out.push("```");
			} else {
				if (rest) out.push(rest);
				fence = kind;
			}
			continue;
		}
		if (/^\s*\{quote\}\s*$/.test(line)) {
			quote = !quote;
			continue;
		}
		// Panels and colors have no Markdown; what they hold is kept.
		if (/^\s*\{(panel|color)(:[^}]*)?\}\s*$/.test(line)) continue;
		const table = /^\s*\|/.test(line);
		if (!table) tableHeader = false;
		let converted: string;
		if (table) {
			const header = /^\s*\|\|/.test(line);
			// Backslashes too, so one at the end of a cell cannot escape the pipe that closes it.
			const cells = splitRow(line, header).map((cell) =>
				inline(cell.trim()).replace(/[\\|]/g, "\\$&"),
			);
			converted = `| ${cells.join(" | ")} |`;
			if (header) {
				out.push(converted);
				out.push(`|${cells.map(() => " --- ").join("|")}|`);
				tableHeader = true;
				continue;
			}
			if (!tableHeader && (out.at(-1) ?? "").trim() === "") {
				// A table without a header row still needs one in Markdown.
				out.push(`|${cells.map(() => "   ").join("|")}|`);
				out.push(`|${cells.map(() => " --- ").join("|")}|`);
				tableHeader = true;
			}
		} else converted = convertLine(line);
		out.push(quote ? `> ${converted}`.trimEnd() : converted);
	}
	if (fence) out.push("```");
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Jira's language names, as Markdown fences name them; unknown ones are left off. */
function languageOf(options: string): string {
	const language = options
		.split("|")
		.map((part) => part.trim())
		.find((part) => part && !part.includes("="));
	return language && /^[A-Za-z0-9#+-]+$/.test(language) ? language.toLowerCase() : "";
}

function splitRow(line: string, header: boolean): string[] {
	const trimmed = line.trim();
	const separator = header ? "||" : "|";
	const inner = trimmed.slice(
		separator.length,
		trimmed.endsWith(separator) ? -separator.length : undefined,
	);
	return inner.split(separator);
}

/** One line outside code and tables: its block markup, then its inline markup. */
function convertLine(line: string): string {
	const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
	if (heading) return `${"#".repeat(Number(heading[1]))} ${inline(heading[2] ?? "")}`;
	const quoted = /^\s*bq\.\s+(.*)$/.exec(line);
	if (quoted) return `> ${inline(quoted[1] ?? "")}`;
	if (/^\s*-{4,}\s*$/.test(line)) return "---";
	const list = /^\s*([*#-]+)\s+(.*)$/.exec(line);
	// A run of `-` alone is a dash list only at one level; `--` starts strikethrough text too often.
	if (list && !(list[1]?.includes("-") && (list[1]?.length ?? 0) > 1)) {
		const marks = list[1] ?? "";
		const indent = "   ".repeat(marks.length - 1);
		const bullet = marks.endsWith("#") ? "1." : "-";
		return `${indent}${bullet} ${inline(list[2] ?? "")}`;
	}
	return inline(line);
}

/** Inline markup, except inside `{{monospace}}`, which becomes a code span as it is. */
function inline(text: string): string {
	return text
		.split(/(\{\{.*?\}\})/)
		.map((part) =>
			part.startsWith("{{") && part.endsWith("}}") && part.length > 4
				? codeSpan(part.slice(2, -2))
				: inlineText(part),
		)
		.join("");
}

function codeSpan(code: string): string {
	const fence = code.includes("`") ? "``" : "`";
	return `${fence}${code}${fence}`;
}

const BEFORE = "(^|[\\s(\\[{>\"'])";
const AFTER = "(?=$|[\\s).,;:!?\\]}\"'<])";
const span = (mark: string) =>
	new RegExp(`${BEFORE}\\${mark}(\\S(?:[^${mark}]*?\\S)?)\\${mark}${AFTER}`, "g");
const BOLD = span("*");
const STRIKE = span("-");
const UNDERLINE = span("+");
const SUPERSCRIPT = span("^");
const SUBSCRIPT = span("~");

function inlineText(text: string): string {
	return (
		text
			// Line breaks Jira writes as `\\`.
			.replace(/\\\\/g, "  \n")
			// Images and other attachments shown inline stay in Jira.
			.replace(/!([^\s!|]+\.[A-Za-z0-9]+)(\|[^!]*)?!/g, (_, file: string) =>
				/^https?:\/\//.test(file) ? `![](${file})` : `_(attachment in Jira: ${file})_`,
			)
			.replace(/\{(color|quote)(:[^}]*)?\}/g, "")
			// Mentions name an account Track does not know.
			.replace(/\[~(accountid:)?([^\]]+)\]/g, (_, id: string | undefined, name: string) =>
				id ? "@someone" : `@${name}`,
			)
			.replace(/\[([^\]|]+)\|([^\]\s]+)\]/g, (_, label: string, url: string) =>
				/^(https?:|mailto:)/.test(url) ? `[${label}](${url})` : label,
			)
			.replace(/\[((?:https?:|mailto:)[^\]\s]+)\]/g, "<$1>")
			// Subscript first: strikethrough's `~~` would read as subscript after.
			.replace(SUBSCRIPT, "$1$2")
			.replace(SUPERSCRIPT, "$1$2")
			.replace(UNDERLINE, "$1$2")
			.replace(BOLD, "$1**$2**")
			.replace(STRIKE, "$1~~$2~~")
			.replace(/\?\?(\S(?:.*?\S)?)\?\?/g, "_$1_")
	);
}
