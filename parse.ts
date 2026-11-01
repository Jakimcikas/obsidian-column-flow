// A columns block:
//   ```columns
//   left
//   +++
//   right
//   ```
// Column ranges run from the start of its first line to the start of the next
// delimiter line, so they include the trailing "\n" (an empty column is from === to).

export interface Col { from: number; to: number }
export interface Block { from: number; to: number; cols: Col[] }

const OPEN = /^```columns\s*$/;
const SEP = /^\+\+\+\s*$/;
const CLOSE = /^```\s*$/;

export function parseBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	let pos = 0;
	let cur: Block | null = null;
	let colStart = 0;
	for (const line of text.split("\n")) {
		const lineEnd = pos + line.length;
		if (!cur) {
			if (OPEN.test(line)) { cur = { from: pos, to: 0, cols: [] }; colStart = lineEnd + 1; }
		} else if (SEP.test(line) || CLOSE.test(line)) {
			cur.cols.push({ from: colStart, to: pos });
			colStart = lineEnd + 1;
			if (CLOSE.test(line)) { cur.to = lineEnd; blocks.push(cur); cur = null; }
		}
		pos = lineEnd + 1;
	}
	return blocks; // an unclosed fence is ignored
}

/** Column text without its trailing newline. */
export const colText = (doc: string, c: Col) => doc.slice(c.from, c.to).replace(/\n$/, "");

/** Split the inside of a columns code block (reading mode gets the raw text). */
export const splitColumns = (src: string) => src.split(/^\+\+\+\s*$/m).map((s) => s.trim());

/** Range to delete to remove column i: its text plus one adjacent +++ line.
 *  Removing the only column deletes the whole block (and its line break). */
export const removeRange = (b: Block, i: number, docLength: number): Col =>
	b.cols.length === 1 ? { from: b.from, to: Math.min(b.to + 1, docLength) }
	: i > 0 ? { from: b.cols[i - 1].to, to: b.cols[i].to }
	: { from: b.cols[0].from, to: b.cols[1].from };

/** Markdown for an empty block with `n` columns (each column is one empty line). */
export const columnsMarkdown = (n: number) => "```columns\n" + Array(n).fill("").join("\n+++\n") + "\n```\n";
