// Run: node parse.test.ts
import assert from "node:assert/strict";
import { parseBlocks, colText, removeRange, columnsMarkdown } from "./parse.ts";

const doc = "intro\n```columns\nleft **a**\nmore\n+++\n+++\nright\n```\nafter\n```columns\nunclosed";
const [b, ...rest] = parseBlocks(doc);
assert.equal(rest.length, 0, "unclosed block ignored");
assert.equal(doc.slice(b.from, b.to), "```columns\nleft **a**\nmore\n+++\n+++\nright\n```");
assert.deepEqual(b.cols.map((c) => colText(doc, c)), ["left **a**\nmore", "", "right"]);

// write-back to the empty middle column keeps structure intact
const c = b.cols[1];
const edited = doc.slice(0, c.from) + "mid\n" + doc.slice(c.to);
assert.deepEqual(parseBlocks(edited)[0].cols.map((c) => colText(edited, c)), ["left **a**\nmore", "mid", "right"]);
// removing first / middle / last column leaves the others intact
const cols = (t: string) => parseBlocks(t)[0].cols.map((c) => colText(t, c));
for (const [i, want] of [[0, ["", "right"]], [1, ["left **a**\nmore", "right"]], [2, ["left **a**\nmore", ""]]] as const) {
	const r = removeRange(b, i, doc.length);
	const t = doc.slice(0, r.from) + doc.slice(r.to);
	assert.deepEqual(cols(t), want, `remove column ${i}`);
}
// inserted template parses to n empty columns
for (const n of [1, 2, 5]) {
	const t = columnsMarkdown(n);
	assert.deepEqual(cols(t), Array(n).fill(""), `template with ${n} columns`);
}
// removing the only column deletes the whole block, mid-note and at the very end
for (const [d, want] of [["a\n```columns\nx\n```\nb", "a\nb"], ["a\n```columns\nx\n```", "a\n"]]) {
	const r = removeRange(parseBlocks(d)[0], 0, d.length);
	assert.equal(d.slice(0, r.from) + d.slice(r.to), want);
}
console.log("ok");
