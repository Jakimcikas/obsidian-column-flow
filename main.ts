import {
	App, Component, Editor, editorInfoField, HoverPopover, Keymap, MarkdownFileInfo, MarkdownRenderChild,
	MarkdownRenderer, Plugin, PluginSettingTab, Scope, SettingDefinitionItem, SuggestModal, TFile,
} from "obsidian";
import { Annotation, EditorState, Extension, Prec, RangeSetBuilder, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, ViewUpdate, WidgetType } from "@codemirror/view";
import { Block, colText, columnsMarkdown, parseBlocks, removeRange, splitColumns } from "./parse";

// Tags transactions written by a column editor: the field maps instead of rebuilding, so the column keeps focus.
const fromColumn = Annotation.define<boolean>();

// ---------- Arrow-key navigation ----------

type Dir = "up" | "down" | "left" | "right" | "backspace";
type Nav = (dir: Dir, v: EditorView) => boolean;
const arrows = (run: Nav) => Prec.highest(keymap.of((["up", "down", "left", "right"] as Dir[]).map((dir) => ({
	key: "Arrow" + dir[0].toUpperCase() + dir.slice(1),
	run: (v: EditorView) => run(dir, v),
}))));

/** True when the cursor can't move further in `dir` inside this editor (respects wrapped lines). */
function atEdge(v: EditorView, dir: Dir): boolean {
	const s = v.state.selection.main;
	if (dir === "backspace") return v.state.doc.length === 0; // empty column
	if (!s.empty) return false;
	if (dir === "left") return s.head === 0;
	if (dir === "right") return s.head === v.state.doc.length;
	const m = v.moveVertically(s, dir === "down");
	return m.head === s.head || v.coordsAtPos(m.head)?.top === v.coordsAtPos(s.head)?.top;
}

/** Opens column `i` of a rendered widget; keyed by the widget's root element. */
type Enter = (i: number, atEnd: boolean) => void;
const enterFns = new WeakMap<HTMLElement, Enter>();

/** Open a column of the block starting at `from`. False if the block is shown as raw markdown. */
function enterBlock(view: EditorView, from: number, i: number, atEnd: boolean): boolean {
	const root = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cf-columns-wrap"))
		.find((el) => view.posAtDOM(el) === from);
	const enter = root && enterFns.get(root);
	if (!enter) return false;
	enter(i, atEnd);
	return true;
}

/** Outer note editor: arrowing into a columns block opens a column instead of skipping it. */
const enterColumns = arrows((dir, view) => {
	const s = view.state.selection.main;
	if (!s.empty) return false;
	const h = s.head;
	for (const b of parseBlocks(view.state.doc.toString())) {
		if (dir === "down" && h < b.from && view.moveVertically(s, true).head >= b.from) return enterBlock(view, b.from, 0, false);
		if (dir === "up" && h > b.to && view.moveVertically(s, false).head <= b.to) return enterBlock(view, b.from, 0, true);
		if (dir === "right" && h === b.from - 1) return enterBlock(view, b.from, 0, false);
		if (dir === "left" && h === b.to + 1) return enterBlock(view, b.from, b.cols.length - 1, true);
	}
	return false;
});

// ---------- Embedded markdown editor ----------
// Obsidian's MarkdownEditor class isn't public. We reach it through a throwaway markdown embed (the same
// approach as the Kanban plugin) and describe only the members we use with these minimal types.

interface EditorOwner extends MarkdownFileInfo {
	editMode?: InternalEditor;
	onMarkdownScroll(): void;
	getMode(): "source";
}
interface InternalEditor {
	owner: EditorOwner;
	editor: Editor & { cm: EditorView };
	_loaded: boolean;
	set(value: string, clear: boolean): void;
	onUpdate(update: ViewUpdate, changed: boolean): void;
	buildLocalExtensions(): Extension[];
	unload(): void;
	destroy(): void;
}
type InternalEditorCtor = new (app: App, el: HTMLElement, owner: EditorOwner) => InternalEditor;
interface MarkdownEmbed { editable: boolean; editMode: object; load(): void; unload(): void; showEditor(): void }
interface EmbedRegistry {
	embedByExtension: { md(ctx: { app: App; containerEl: HTMLElement; state: object }, file: null, subpath: string): MarkdownEmbed };
}

type ColumnEditorCtor = new (
	app: App, el: HTMLElement, file: TFile | null, value: string, onChange: (v: string) => void, onNav: Nav,
) => InternalEditor;
let ColumnEditor: ColumnEditorCtor | null = null;

function getColumnEditor(app: App): ColumnEditorCtor {
	if (ColumnEditor) return ColumnEditor;
	const registry = (app as App & { embedRegistry: EmbedRegistry }).embedRegistry;
	const embed = registry.embedByExtension.md({ app, containerEl: createDiv(), state: {} }, null, "");
	embed.load();
	embed.editable = true;
	embed.showEditor();
	const proto = Object.getPrototypeOf(Object.getPrototypeOf(embed.editMode) as object) as { constructor: InternalEditorCtor };
	const Base = proto.constructor;
	embed.unload();

	ColumnEditor = class extends Base {
		onChange: (v: string) => void;
		onNav: Nav | undefined;
		scope: Scope;
		constructor(app: App, el: HTMLElement, file: TFile | null, value: string, onChange: (v: string) => void, onNav: Nav) {
			super(app, el, { app, file, hoverPopover: null as HoverPopover | null, onMarkdownScroll: () => {}, getMode: () => "source" });
			this.onChange = onChange;
			this.onNav = onNav;
			this.scope = new Scope(app.scope);
			this.owner.editMode = this;
			this.owner.editor = this.editor;
			this.set(value, false);
			// Route Obsidian commands/hotkeys (Cmd+B etc.) to this editor while it has focus.
			const cm = this.editor.cm;
			let prev: MarkdownFileInfo | null = null;
			cm.contentDOM.addEventListener("focusin", () => {
				app.keymap.pushScope(this.scope);
				prev = app.workspace.activeEditor;
				app.workspace.activeEditor = this.owner;
			});
			cm.contentDOM.addEventListener("blur", () => {
				app.keymap.popScope(this.scope);
				if (app.workspace.activeEditor === this.owner) app.workspace.activeEditor = prev;
			});
		}
		onUpdate(update: ViewUpdate, changed: boolean) {
			super.onUpdate(update, changed);
			if (changed) this.onChange(this.editor.cm.state.doc.toString());
		}
		buildLocalExtensions() {
			// Runs inside super(), before onNav is assigned, so look it up at key time.
			const nav = (dir: Dir) => (v: EditorView) => this.onNav?.(dir, v) ?? false;
			return [
				...super.buildLocalExtensions(),
				arrows((dir, v) => nav(dir)(v)),
				Prec.highest(keymap.of([{ key: "Mod-Backspace", run: nav("backspace") }])),
			];
		}
		destroy() {
			if (this._loaded) this.unload();
			super.destroy();
		}
	};
	return ColumnEditor;
}

// ---------- Live Preview widget ----------

class ColumnsWidget extends WidgetType {
	editors: InternalEditor[] = [];
	renderer = new Component(); // owns rendered-markdown children (embeds etc.); unloaded with the widget
	constructor(readonly app: App, readonly source: string, readonly cols: string[]) { super(); }

	eq(other: ColumnsWidget) { return other.source === this.source; }

	toDOM(view: EditorView) {
		const root = createDiv({ cls: "cf-columns-wrap" });
		const grid = root.createDiv({ cls: "cf-columns" });
		const file = view.state.field(editorInfoField)?.file ?? null;
		const sourcePath = file?.path ?? "";
		this.renderer.load();
		const n = this.cols.length;
		const enters: ((atEnd: boolean) => void)[] = [];
		enterFns.set(root, (i, atEnd) => enters[i]?.(atEnd));
		// Leave the block to the line before/after it (creating one at the start/end of the note).
		const exit = (after: boolean) => {
			const b = blockAt(view, root);
			if (!b) return;
			if (after) view.dispatch(b.to < view.state.doc.length
				? { selection: { anchor: b.to + 1 } }
				: { changes: { from: b.to, insert: "\n" }, selection: { anchor: b.to + 1 } });
			else view.dispatch(b.from > 0
				? { selection: { anchor: b.from - 1 } }
				: { changes: { from: 0, insert: "\n" }, selection: { anchor: 0 } });
			view.focus();
		};
		this.cols.forEach((initial, i) => {
			let text = initial;
			const col = grid.createDiv({ cls: "cf-column" });
			const cell = col.createDiv({ cls: "cf-column-body" }); // emptied on show/edit; the × button lives outside it
			let editor: InternalEditor | null = null;
			const x = col.createEl("button", {
				cls: "cf-remove", text: "×", attr: { "aria-label": n > 1 ? "Remove column" : "Remove columns block" },
			});
			x.onclick = (e) => {
				e.stopPropagation();
				const b = blockAt(view, root);
				if (b) view.dispatch({ changes: removeRange(b, i, view.state.doc.length) });
			};
			const show = () => {
				cell.empty();
				cell.removeClass("is-editing");
				if (!text.trim()) cell.createDiv({ cls: "cf-placeholder", text: "Click to write…" });
				else void MarkdownRenderer.render(this.app, text, cell, sourcePath, this.renderer);
			};
			// Cmd/Ctrl+Backspace in an empty column: remove it and move to the previous column
			// (or, if it was the only one, delete the block and go to the end of the line above).
			const removeEmpty = () => {
				const b = blockAt(view, root);
				if (!b) return;
				view.dispatch({ changes: removeRange(b, i, view.state.doc.length) });
				if (b.cols.length > 1) { enterBlock(view, b.from, Math.max(i - 1, 0), i > 0); return; }
				view.dispatch({ selection: { anchor: Math.max(b.from - 1, 0) } });
				view.focus();
			};
			const nav: Nav = (dir, v) => {
				if (!atEdge(v, dir)) return false;
				// Deferred: removing the column destroys this editor, so don't do it inside its own key handler.
				if (dir === "backspace") window.setTimeout(removeEmpty);
				else if (dir === "left" && i > 0) enters[i - 1](true);
				else if (dir === "right" && i < n - 1) enters[i + 1](false);
				else exit(dir === "down" || dir === "right");
				return true;
			};
			const edit = (atEnd = true) => {
				if (!editor) {
					cell.empty();
					cell.addClass("is-editing");
					const Editor = getColumnEditor(this.app);
					editor = new Editor(this.app, cell, file, text, (v) => {
						text = v;
						writeBack(view, root, i, v);
					}, nav);
					this.editors.push(editor);
				}
				const cm = editor.editor.cm;
				cm.dispatch({ selection: { anchor: atEnd ? cm.state.doc.length : 0 } });
				cm.focus();
			};
			enters.push(edit);
			const close = () => {
				if (!editor) return;
				this.editors.remove(editor);
				editor.destroy();
				editor = null;
				show();
			};
			cell.addEventListener("click", (e) => {
				if (editor) return;
				const a = (e.target as HTMLElement).closest("a");
				if (a?.hasClass("internal-link")) {
					e.preventDefault();
					void this.app.workspace.openLinkText(a.getAttr("data-href") ?? a.getText(), sourcePath, Keymap.isModEvent(e));
				} else if (!a) edit(); // external links open normally
			});
			// Close when focus leaves the card (deferred: link/autocomplete popups briefly move focus).
			// cell.doc / cell.win keep this working in popout windows.
			cell.addEventListener("focusout", () => cell.win.setTimeout(() => {
				if (!cell.contains(cell.doc.activeElement)) close();
			}));
			cell.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
			show();
		});
		const bar = root.createDiv({ cls: "cf-toolbar" });
		bar.createEl("button", { text: "+ column" }).onclick = () => {
			const b = blockAt(view, root);
			if (b) view.dispatch({ changes: { from: b.cols[b.cols.length - 1].to, insert: "+++\n\n" } }); // before closing ```
		};
		bar.createEl("button", { text: "</>", attr: { "aria-label": "Edit raw Markdown" } }).onclick = () => {
			const b = blockAt(view, root);
			if (b) { view.dispatch({ selection: { anchor: b.from } }); view.focus(); }
		};
		return root;
	}

	destroy() { this.editors.forEach((e) => e.destroy()); this.renderer.unload(); }
	ignoreEvent() { return true; }
}

function blockAt(view: EditorView, dom: HTMLElement): Block | undefined {
	const pos = view.posAtDOM(dom);
	return parseBlocks(view.state.doc.toString()).find((b) => b.from === pos);
}

function writeBack(view: EditorView, dom: HTMLElement, i: number, value: string) {
	const b = blockAt(view, dom);
	const c = b?.cols[i];
	if (!c || colText(view.state.doc.toString(), c) === value) return;
	view.dispatch({ changes: { from: c.from, to: c.to, insert: value + "\n" }, annotations: fromColumn.of(true) });
}

function build(app: App, state: EditorState): DecorationSet {
	const doc = state.doc.toString();
	const sel = state.selection.main;
	const out = new RangeSetBuilder<Decoration>();
	for (const b of parseBlocks(doc)) {
		if (sel.to >= b.from && sel.from <= b.to) continue; // cursor inside the fence: show raw markdown
		const widget = new ColumnsWidget(app, doc.slice(b.from, b.to), b.cols.map((c) => colText(doc, c)));
		out.add(b.from, b.to, Decoration.replace({ widget, block: true }));
	}
	return out.finish();
}

const columnsField = (app: App) => StateField.define<DecorationSet>({
	create: (state) => build(app, state),
	update(deco, tr: Transaction) {
		if (tr.annotation(fromColumn)) return deco.map(tr.changes);
		// ponytail: full-doc reparse on every change/selection move; fine for normal notes, cache per-block if huge notes lag
		return tr.docChanged || tr.selection ? build(app, tr.state) : deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// ---------- Plugin ----------

interface Settings { bordered: boolean }

export default class ColumnFlow extends Plugin {
	settings: Settings = { bordered: false };

	applyStyle() { document.body.toggleClass("cf-bordered", this.settings.bordered); }

	async onload() {
		Object.assign(this.settings, (await this.loadData()) as Partial<Settings> | null);
		this.applyStyle();
		this.addSettingTab(new ColumnFlowSettings(this));
		this.registerEditorExtension([columnsField(this.app), enterColumns]);
		this.addCommand({
			id: "insert-columns",
			name: "Insert columns",
			icon: "columns-3",
			editorCallback: (editor) => new ColumnCountModal(this.app, (n) => insertColumns(editor, n)).open(),
		});

		// Reading mode. A post-processor (not a code-block processor) so Obsidian's own Live Preview
		// code-block widget doesn't compete with the editor extension above.
		this.registerMarkdownPostProcessor((el, ctx) => {
			el.querySelectorAll("pre > code.language-columns").forEach((code) => {
				const grid = createDiv({ cls: "cf-columns" });
				const child = new MarkdownRenderChild(grid); // unloaded with this rendered section
				ctx.addChild(child);
				for (const md of splitColumns(code.textContent ?? "")) {
					void MarkdownRenderer.render(this.app, md, grid.createDiv({ cls: "cf-column" }), ctx.sourcePath, child);
				}
				code.parentElement?.replaceWith(grid);
			});
		});
	}

	onunload() { document.body.removeClass("cf-bordered"); }
}

/** Insert an empty block at the cursor (on its own line) and start editing the first column. */
function insertColumns(editor: Editor, n: number) {
	const view = (editor as Editor & { cm: EditorView }).cm;
	const { from, to } = view.state.selection.main;
	const line = view.state.doc.lineAt(from);
	const pre = from === line.from ? "" : "\n"; // mid-line: start the block on a new line
	const at = from + pre.length;
	view.dispatch({ changes: { from, to, insert: pre + columnsMarkdown(n) }, selection: { anchor: at + columnsMarkdown(n).length } });
	window.setTimeout(() => enterBlock(view, at, 0, false)); // after the modal hands focus back to the note
}

class ColumnCountModal extends SuggestModal<number> {
	constructor(app: App, readonly onPick: (n: number) => void) {
		super(app);
		this.setPlaceholder("Number of columns (1–12)");
	}
	getSuggestions(query: string) {
		const n = parseInt(query, 10);
		return n >= 1 && n <= 12 ? [n] : [2, 3, 4, 5, 6];
	}
	renderSuggestion(n: number, el: HTMLElement) { el.setText(`${n} column${n === 1 ? "" : "s"}`); }
	onChooseSuggestion(n: number) { this.onPick(n); }
}

// Declarative settings (Obsidian 1.13+): rendered by Obsidian and included in settings search.
class ColumnFlowSettings extends PluginSettingTab {
	constructor(readonly plugin: ColumnFlow) { super(plugin.app, plugin); }

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{
			name: "Bordered columns",
			desc: "Draw a border around every column. For a single note, add `cssclasses: cf-bordered` to its frontmatter instead.",
			aliases: ["border", "columns"],
			control: { type: "toggle", key: "bordered", defaultValue: false },
		}];
	}

	async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value); // updates plugin.settings and saves
		this.plugin.applyStyle();
	}
}
