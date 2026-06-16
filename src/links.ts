import { splitOutCode } from "./math.ts";

// An inline link to an internal anchor, e.g. [Overview](#overview). The terminal
// has no way to act on a #fragment target and there is no app-owned scroll-to-
// anchor, so pi-tui's Markdown renders these as broken clickable links. We drop
// the link wrapper and keep the visible text. The negative lookbehind leaves
// images (![alt](#...)) untouched; external http(s)/mailto links are unaffected.
const INTERNAL_ANCHOR_LINK = /(?<!!)\[([^\]]+)\]\(#[^)]*\)/g;

/** Replace internal anchor links with their plain link text, skipping code spans. */
export function stripInternalAnchorLinks(markdown: string): string {
    return splitOutCode(markdown)
        .map((seg) => (seg.code ? seg.text : seg.text.replace(INTERNAL_ANCHOR_LINK, "$1")))
        .join("");
}
