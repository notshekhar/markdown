# markdown

`md` — render markdown (and LaTeX source) in your terminal with syntax
highlighting, math, and mermaid. Built on
[`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
(the renderer behind pi).

## Install

Prebuilt binary (no node/bun required):

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/markdown/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/notshekhar/markdown/main/install.ps1 | iex
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
markdown                 # browse the current folder (interactive)
markdown <dir>           # browse under <dir>
markdown <file.md>       # open a markdown file in the interactive viewer
markdown <file.tex>      # open a LaTeX file as a readable preview
markdown <file> -p       # print rendered output and exit (also used when piped)
markdown serve [path]    # web preview in the browser (light + dark themes)

markdown update          # update to the latest version (alias: upgrade)
markdown version         # print the version
```

### Web serve

```bash
markdown serve                 # cwd — opens browser
markdown serve ./docs          # folder
markdown serve README.md       # single file
markdown serve --port 8080     # pick port
markdown serve --no-open       # print URL only
```

Same features as the terminal renderer: GFM markdown, code highlighting,
KaTeX math, mermaid diagrams, and `.tex` → readable preview. Header toggle
switches light/dark.

UI state — theme, font, sidebar, open tabs, expanded folders and recent files
— is stored server-side in `~/.markdown/state.db` (SQLite), not in the
browser, so it follows you across browsers and private windows. Set
`MARKDOWN_CONFIG_DIR` to put it elsewhere; deleting the file just resets the
UI to defaults.

The command is `markdown` (a `md` alias is also installed, but many shells
already alias `md` to `mkdir`, which would shadow it).

The browser shows folders plus **markdown** (`.md`, `.markdown`, `.mdx`) and
**LaTeX** (`.tex`, `.latex`, `.ltx`) files. Enter a folder to descend; `esc`
walks back up to the parent and never quits (use Ctrl+C to quit).

### Preview a resume (example)

```bash
# from the monorepo root — pure JS, no TeX install required
bun ./markdown/src/cli.ts resume/draft-resume-1.0.tex

# print mode (no TUI)
bun ./markdown/src/cli.ts resume/draft-resume-1.0.tex -p | head
```

LaTeX preview is **in-process only**: a small pure-TypeScript converter
(`src/tex.ts`) maps common macros (`\section`, `\textbf`, `\href`,
Jake-resume `\resumeItem` / `\resumeSubheading`, …) to markdown, then the
normal markdown renderer paints it. No `pdflatex`, no extra npm packages,
no network.

### Interactive keys

| Key            | Action            |
| -------------- | ----------------- |
| `↑`/`↓`, `j`/`k` | scroll          |
| `space` / `b`  | page down / up    |
| `g` / `G`      | top / bottom      |
| mouse wheel    | scroll            |
| `u`            | cycle UI mode (`md` ↔ `noir`) |
| `e`            | edit              |
| `enter`        | open file / enter folder |
| `esc`          | back (viewer → browser, folder → parent) |
| `ctrl+c`       | quit              |

Typing in the browser fuzzy-filters the current folder.

### UI modes (like loop)

Two builtin looks — pure TypeScript, no extra packages:

| Mode   | Look |
| ------ | ---- |
| `md`   | Jade header pill, no canvas wash (default) |
| `noir` | Dark cockpit: OSC 11 background wash, `◆` header, `┃` content gutters, jade accents |

```bash
markdown resume/draft-resume-1.0.tex --ui noir
MD_UI_MODE=noir markdown .
# or press `u` inside the viewer to cycle
```

The mode you pick with `u` is remembered, along with your editor `:set`
options and the line you stopped reading at in each file — all in
`~/.markdown/state.db`, the same store `markdown serve` uses.

## Features

- **Markdown** — headings, lists, tables, blockquotes, links, inline styles.
- **LaTeX preview** — `.tex` / `.latex` / `.ltx` converted to readable
  markdown in pure TypeScript (no TeX engine). Good for resume review.
- **Syntax highlighting** — [Shiki](https://shiki.style) (the highlighter
  behind VS Code) with ~330 languages, mapped to terminal colors (truecolor
  where supported, gracefully downsampled otherwise). Code blocks with no
  language are auto-detected; prose-y blocks are left plain.
- **Math** — `$inline$`, `$$display$$`, and `\(...\)` / `\[...\]` rendered to Unicode.
- **Mermaid** — `graph`/`flowchart` diagrams drawn as labeled flows. Set
  `MD_MERMAID_IMAGES=1` to render diagrams as inline images via the mermaid CLI
  on terminals that support images (iTerm2/kitty).
- **Code blocks** are framed cards with the language on the border, matching
  the web UI; long lines wrap inside the frame.
- **Complex scripts** — Devanagari, Thai, Hangul jamo and friends are measured
  in terminal cells, not grapheme clusters, so tables and frames stay square
  in Hindi as they do in English. Terminals disagree about cluster layout, so
  the viewer probes yours at startup and lays out to match.

## Editing

Press `e` in the viewer to open the current file in the in-app editor (or
`$VISUAL`/`$EDITOR` depending on mode). On exit the file is re-read and
re-rendered.
