// Run: node parse.test.ts
import assert from "node:assert/strict";
import { parseBlocks, colText, removeRange } from "./parse.ts";

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
	const r = removeRange(b, i);
	const t = doc.slice(0, r.from) + doc.slice(r.to);
	assert.deepEqual(cols(t), want, `remove column ${i}`);
}
console.log("ok");
