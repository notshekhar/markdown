# markdown

`md` — render markdown in your terminal with syntax highlighting, math, and mermaid. Built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) (the renderer behind pi).

## Install

```bash
bun install
bun run build        # compiles ./dist
bun link             # exposes the `md` binary
```

Or run straight from source:

```bash
bun ./src/cli.ts <file.md>
```

## Usage

```bash
md                 # browse markdown files in the current folder (interactive)
md <dir>           # browse markdown files under <dir>
md <file.md>       # open a file in the interactive viewer
md <file.md> -p    # print rendered output and exit (also used when piped)
```

### Interactive keys

| Key            | Action            |
| -------------- | ----------------- |
| `↑`/`↓`, `j`/`k` | scroll          |
| `space` / `b`  | page down / up    |
| `g` / `G`      | top / bottom      |
| mouse wheel    | scroll            |
| `e`            | edit in `$EDITOR` |
| `enter`        | open (browser)    |
| `esc` / `q`    | back / quit       |

Typing in the browser fuzzy-filters the file list.

## Features

- **Markdown** — headings, lists, tables, blockquotes, links, inline styles.
- **Syntax highlighting** — `highlight.js` mapped to terminal colors.
- **Math** — `$inline$`, `$$display$$`, and `\(...\)` / `\[...\]` rendered to Unicode.
- **Mermaid** — `graph`/`flowchart` diagrams drawn as labeled flows. Set
  `MD_MERMAID_IMAGES=1` to render diagrams as inline images via the mermaid CLI
  on terminals that support images (iTerm2/kitty).

## Editing

Press `e` in the viewer to open the current file in `$VISUAL`/`$EDITOR`
(falls back to `vim`). On exit the file is re-read and re-rendered.
