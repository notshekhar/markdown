# markdown

`md` — render markdown in your terminal with syntax highlighting, math, and mermaid. Built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) (the renderer behind pi).

## Install

Prebuilt binary (no node/bun required):

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/markdown/main/install.sh | bash
```

From source:

```bash
bun install
bun build-bin.ts     # standalone binary in dist/bin/<target>/md
bun ./src/cli.ts <file.md>   # or just run it directly
```

Update later with `md update` (or re-run the installer). Uninstall with
`MD_UNINSTALL=1 curl -fsSL .../install.sh | bash`.

## Usage

```bash
md                 # browse the current folder (interactive)
md <dir>           # browse under <dir>
md <file.md>       # open a file in the interactive viewer
md <file.md> -p    # print rendered output and exit (also used when piped)

md update          # update to the latest version (alias: upgrade)
md version         # print the version
```

The browser shows folders and markdown files. Enter a folder to descend;
`esc` walks back up to the parent and never quits (use Ctrl+C to quit).

### Interactive keys

| Key            | Action            |
| -------------- | ----------------- |
| `↑`/`↓`, `j`/`k` | scroll          |
| `space` / `b`  | page down / up    |
| `g` / `G`      | top / bottom      |
| mouse wheel    | scroll            |
| `e`            | edit in `$EDITOR` |
| `enter`        | open file / enter folder |
| `esc`          | back (viewer → browser, folder → parent) |
| `ctrl+c`       | quit              |

Typing in the browser fuzzy-filters the current folder.

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
