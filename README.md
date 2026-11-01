# Column Flow

Side-by-side columns in Obsidian that you can **edit directly in Live Preview**, not only in Reading mode.

Each column is shown as a rendered card. Click one (or arrow into it) and it turns into a real Obsidian editor, with formatting, links, autocomplete and hotkeys. Click away and it goes back to the rendered card.

## Usage

````markdown
```columns
Left column with **markdown**, [[links]] and lists
+++
Right column
```
````

`+++` on its own line separates the columns. Without the plugin installed, this is still a plain code block, so your notes stay readable.

- **Edit:** click a column, or move into it with the arrow keys.
- **Navigate:** ←/→ at the start or end of a column jumps to the neighbouring column, and ↑/↓ at the top or bottom leaves the block. Esc closes the editor.
- **Add or remove columns:** hover over the block for **+ column**, or over a column for **×**.
- **Raw markdown:** the **</>** button shows the block's source.

## Styling

Columns are borderless by default. To add borders:

- **Every note:** Settings → Column Flow → *Bordered columns*.
- **One note:** add `cssclasses: cf-bordered` to the note's frontmatter.

## Install (manual)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/column-flow/`.
3. Enable **Column Flow** in Settings → Community plugins.

## Development

```bash
npm run dev          # rebuild on change
node parse.test.ts   # parser self-check
```

The in-place column editors use Obsidian's internal markdown editor class (the same approach as the Kanban plugin). That API isn't public, so an Obsidian update could break it.

## License

MIT
