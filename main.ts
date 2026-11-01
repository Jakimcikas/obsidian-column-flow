import { App, Component, editorInfoField, Keymap, MarkdownRenderer, Plugin, PluginSettingTab, Scope, Setting } from "obsidian";
import { Annotation, EditorState, Prec, RangeSetBuilder, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { Block, colText, parseBlocks, removeRange, splitColumns } from "./parse";

// Tags transactions written by a column editor: the field maps instead of rebuilding, so the column keeps focus.
const fromColumn = Annotation.define<boolean>();

// ---------- Arrow-key navigation ----------

type Dir = "up" | "down" | "left" | "right";
type Nav = (dir: Dir, v: EditorView) => boolean;
const arrows = (run: Nav) => Prec.highest(keymap.of((["up", "down", "left", "right"] as Dir[]).map((dir) => ({
	key: "Arrow" + dir[0].toUpperCase() + dir.slice(1),
	run: (v: EditorView) => run(dir, v),
}))));

/** True when the cursor can't move further in `dir` inside this editor (respects wrapped lines). */
function atEdge(v: EditorView, dir: Dir): boolean {
	const s = v.state.selection.main;
	if (!s.empty) return false;
	if (dir === "left") return s.head === 0;
	if (dir === "right") return s.head === v.state.doc.length;
	const m = v.moveVertically(s, dir === "down");
	return m.head === s.head || v.coordsAtPos(m.head)?.top === v.coordsAtPos(s.head)?.top;
}

/** Outer note editor: arrowing into a columns block opens a column instead of skipping it. */
const enterColumns = arrows((dir, view) => {
	const s = view.state.selection.main;
	if (!s.empty) return false;
	const h = s.head;
	for (const b of parseBlocks(view.state.doc.toString())) {
		let target: [number, boolean] | null = null; // [column, cursor at end]
		if (dir === "down" && h < b.from && view.moveVertically(s, true).head >= b.from) target = [0, false];
		else if (dir === "up" && h > b.to && view.moveVertically(s, false).head <= b.to) target = [0, true];
		else if (dir === "right" && h === b.from - 1) target = [0, false];
		else if (dir === "left" && h === b.to + 1) target = [b.cols.length - 1, true];
		if (!target) continue;
		const root = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cf-columns-wrap"))
			.find((el) => view.posAtDOM(el) === b.from) as Any;
		if (!root?.lcEnter) return false; // block shown as raw markdown: normal cursor movement
		root.lcEnter(...target);
		return true;
	}
	return false;
});

// ---------- Embedded markdown editor (private Obsidian API, same trick as the Kanban plugin) ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let EditorClass: Any = null;

function getEditorClass(app: App): Any {
	if (EditorClass) return EditorClass;
	const embed = (app as Any).embedRegistry.embedByExtension.md({ app, containerEl: createDiv(), state: {} }, null, "");
	embed.load();
	embed.editable = true;
	embed.showEditor();
	const Base = Object.getPrototypeOf(Object.getPrototypeOf(embed.editMode)).constructor;
	embed.unload();

	EditorClass = class extends Base {
		onChange: (v: string) => void;
		onNav: Nav;
		scope: Scope;
		constructor(app: App, el: HTMLElement, value: string, onChange: (v: string) => void, onNav: Nav) {
			super(app, el, { app, onMarkdownScroll: () => {}, getMode: () => "source" });
			this.onChange = onChange;
			this.onNav = onNav;
			this.scope = new Scope((app as Any).scope);
			this.owner.editMode = this;
			this.owner.editor = this.editor;
			this.set(value, false);
			// Route Obsidian commands/hotkeys (Cmd+B etc.) to this editor while it has focus.
			const cm: EditorView = this.editor.cm;
			let prev: Any = null;
			cm.contentDOM.addEventListener("focusin", () => {
				(app as Any).keymap.pushScope(this.scope);
				prev = app.workspace.activeEditor;
				(app.workspace as Any).activeEditor = this.owner;
			});
			cm.contentDOM.addEventListener("blur", () => {
				(app as Any).keymap.popScope(this.scope);
				if (app.workspace.activeEditor === this.owner) (app.workspace as Any).activeEditor = prev;
			});
		}
		onUpdate(update: Any, changed: boolean) {
			super.onUpdate(update, changed);
			if (changed) this.onChange(this.editor.cm.state.doc.toString());
		}
		buildLocalExtensions() {
			// runs inside super(), before onNav is assigned, so look it up at key time
			return [...super.buildLocalExtensions(), arrows((dir, v) => this.onNav?.(dir, v) ?? false)];
		}
		destroy() {
			if (this._loaded) this.unload();
			super.destroy();
		}
	};
	return EditorClass;
}

// ---------- Live Preview widget ----------

class ColumnsWidget extends WidgetType {
	editors: Any[] = [];
	renderer = new Component(); // owns rendered-markdown children (embeds etc.)
	constructor(readonly app: App, readonly source: string, readonly cols: string[]) { super(); }

	eq(other: ColumnsWidget) { return other.source === this.source; }

	toDOM(view: EditorView) {
		const root = createDiv({ cls: "cf-columns-wrap" });
		const grid = root.createDiv({ cls: "cf-columns" });
		const sourcePath = view.state.field(editorInfoField)?.file?.path ?? "";
		this.renderer.load();
		const n = this.cols.length;
		const enters: ((atEnd: boolean) => void)[] = [];
		(root as Any).lcEnter = (i: number, atEnd: boolean) => enters[i]?.(atEnd);
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
		this.cols.forEach((text, i) => {
			const col = grid.createDiv({ cls: "cf-column" });
			const cell = col.createDiv({ cls: "cf-column-body" }); // emptied on show/edit; the × button lives outside it
			let editor: Any = null;
			if (this.cols.length > 1) {
				const x = col.createEl("button", { cls: "cf-remove", text: "×", attr: { "aria-label": "Remove column" } });
				x.onclick = (e) => {
					e.stopPropagation();
					const b = blockAt(view, root);
					if (b && b.cols.length > 1) view.dispatch({ changes: removeRange(b, i) });
				};
			}
			const show = () => {
				cell.empty();
				cell.removeClass("is-editing");
				if (!text.trim()) cell.createDiv({ cls: "cf-placeholder", text: "Click to write…" });
				else MarkdownRenderer.render(this.app, text, cell, sourcePath, this.renderer);
			};
			const nav: Nav = (dir, v) => {
				if (!atEdge(v, dir)) return false;
				if (dir === "left" && i > 0) enters[i - 1](true);
				else if (dir === "right" && i < n - 1) enters[i + 1](false);
				else exit(dir === "down" || dir === "right");
				return true;
			};
			const edit = (atEnd = true) => {
				if (!editor) {
					cell.empty();
					cell.addClass("is-editing");
					editor = new (getEditorClass(this.app))(this.app, cell, text, (v: string) => {
						text = v;
						writeBack(view, root, i, v);
					}, nav);
					this.editors.push(editor);
				}
				const cm: EditorView = editor.editor.cm;
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
					this.app.workspace.openLinkText(a.getAttr("data-href") ?? a.getText(), sourcePath, Keymap.isModEvent(e));
				} else if (!a) edit(); // external links open normally
			});
			// Close when focus leaves the card (deferred: link/autocomplete popups briefly move focus)
			cell.addEventListener("focusout", () => setTimeout(() => {
				if (!cell.contains(document.activeElement)) close();
			}));
			cell.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
			show();
		});
		const bar = root.createDiv({ cls: "cf-toolbar" });
		bar.createEl("button", { text: "+ column" }).onclick = () => {
			const b = blockAt(view, root);
			if (b) view.dispatch({ changes: { from: b.cols[b.cols.length - 1].to, insert: "+++\n\n" } }); // before closing ```
		};
		bar.createEl("button", { text: "</>", attr: { "aria-label": "Edit raw markdown" } }).onclick = () => {
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

export default class ColumnFlow extends Plugin {
	settings = { bordered: false };

	applyStyle() { document.body.toggleClass("cf-bordered", this.settings.bordered); }

	async onload() {
		Object.assign(this.settings, await this.loadData());
		this.applyStyle();
		this.addSettingTab(new ColumnFlowSettings(this));
		this.registerEditorExtension([columnsField(this.app), enterColumns]);

		// Reading mode. A post-processor (not a code-block processor) so Obsidian's own Live Preview
		// code-block widget doesn't compete with the editor extension above.
		this.registerMarkdownPostProcessor((el, ctx) => {
			el.querySelectorAll("pre > code.language-columns").forEach((code) => {
				const grid = createDiv({ cls: "cf-columns" });
				for (const md of splitColumns(code.textContent ?? "")) {
					MarkdownRenderer.render(this.app, md, grid.createDiv({ cls: "cf-column" }), ctx.sourcePath, this);
				}
				code.parentElement!.replaceWith(grid);
			});
		});
	}

	onunload() { document.body.removeClass("cf-bordered"); }
}

class ColumnFlowSettings extends PluginSettingTab {
	constructor(readonly plugin: ColumnFlow) { super(plugin.app, plugin); }

	display() {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName("Bordered columns")
			.setDesc("Draw a border around every column. For a single note, add `cssclasses: cf-bordered` to its frontmatter instead.")
			.addToggle((t) => t.setValue(this.plugin.settings.bordered).onChange(async (v) => {
				this.plugin.settings.bordered = v;
				this.plugin.applyStyle();
				await this.plugin.saveData(this.plugin.settings);
			}));
	}
}
