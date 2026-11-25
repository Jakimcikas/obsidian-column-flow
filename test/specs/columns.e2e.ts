import { browser, $, $$, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { obsidianPage } from "wdio-obsidian-service";

const NOTE = "intro\n```columns\n# aaaa\n+++\ncolumn b\n```\nafter\n";
// Each test opens its note in a new tab; only look at the active one.
const LEAF = ".workspace-leaf.mod-active";
const COL = `${LEAF} .cf-column`;

/** Full text of the open note, as the outer editor holds it (column edits are written back into it). */
const noteText = () => browser.executeObsidian(({ app, obsidian }) =>
	app.workspace.getActiveViewOfType(obsidian.MarkdownView)!.editor.getValue());

/** Index of the column holding focus, -1 if focus is outside every column. */
const focusedColumn = () => browser.execute(() => {
	const col = document.activeElement?.closest(".cf-column");
	return col ? Array.from(col.parentElement!.children).indexOf(col) : -1;
});

/** Put the outer note's cursor on `line` and focus it. */
const outerCursor = (line: number) => browser.executeObsidian(({ app, obsidian }, line) => {
	const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)!.editor;
	editor.setCursor({ line, ch: 0 });
	editor.focus();
}, line);

const column = async (i: number) => (await $$(COL))[i];
const clickColumn = async (i: number) => (await column(i)).$(".cm-content").click();

let n = 0;
beforeEach(async () => {
	// A fresh note per test: no leftover edits or pending saves from the previous test.
	const file = `note-${n++}.md`;
	await obsidianPage.write(file, NOTE);
	await obsidianPage.openFile(file);
	await outerCursor(0);
	await expect($$(COL)).toBeElementsArrayOfSize(2);
});

describe("Column Flow in Live Preview", () => {
	it("applies Live Preview CSS snippets to columns that aren't being edited (issue #3)", async () => {
		const heading = (await column(0)).$(".HyperMD-header-1");
		const color = async () => (await heading.getCSSProperty("color")).parsed.hex;
		expect(await color()).toBe("#ff8000"); // set by test/vault/.obsidian/snippets/heading-snippet.css
		await clickColumn(0);
		await outerCursor(6); // edit, then leave the column
		expect(await focusedColumn()).toBe(-1);
		expect(await color()).toBe("#ff8000");
	});

	it("writes typed text back into the note", async () => {
		await clickColumn(1);
		await browser.keys(["End"]);
		await browser.keys(" typed");
		await browser.waitUntil(async () => (await noteText()).includes("column b typed\n```"));
	});

	it("moves between the note and columns with arrow keys", async () => {
		await browser.keys(["ArrowDown"]); // "intro" -> first column
		expect(await focusedColumn()).toBe(0);
		await browser.keys(["End"]);
		await browser.keys(["ArrowRight"]); // end of column 0 -> column 1
		expect(await focusedColumn()).toBe(1);
		await browser.keys(["ArrowDown"]); // last line of the block -> "after"
		expect(await focusedColumn()).toBe(-1);
		const line = await browser.executeObsidian(({ app, obsidian }) =>
			app.workspace.getActiveViewOfType(obsidian.MarkdownView)!.editor.getCursor().line);
		expect(line).toBe(6);
	});

	it("routes Obsidian commands to the focused column", async () => {
		await clickColumn(1);
		await browser.keys(["End"]);
		await browser.keys([Key.Shift, "Home"]);
		await browser.executeObsidianCommand("editor:toggle-bold");
		await browser.waitUntil(async () => (await noteText()).includes("**column b**"));
	});

	it("adds a column, then removes it again with Mod+Backspace while empty", async () => {
		await $(`${LEAF} .cf-columns-wrap`).moveTo();
		await $(`${LEAF} .cf-toolbar button:first-child`).click(); // "+ column"
		await expect($$(COL)).toBeElementsArrayOfSize(3);
		await clickColumn(2);
		await browser.keys([Key.Ctrl, "Backspace"]); // Key.Ctrl is Cmd on macOS
		await expect($$(COL)).toBeElementsArrayOfSize(2);
		expect(await noteText()).toBe(NOTE);
	});

	it("removes a column with its × button", async () => {
		const col = await column(1);
		await col.moveTo();
		await col.$(".cf-remove").click();
		await expect($$(COL)).toBeElementsArrayOfSize(1);
		expect(await noteText()).not.toContain("column b");
	});
});

describe("Column Flow in reading mode", () => {
	it("renders the block as columns", async () => {
		await browser.executeObsidianCommand("markdown:toggle-preview");
		await expect($$(`${LEAF} .markdown-reading-view .cf-column`)).toBeElementsArrayOfSize(2);
	});
});
