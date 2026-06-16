// Lightweight LaTeX math → Unicode renderer. We don't aim for KaTeX fidelity;
// we cover the common constructs that read well in a terminal: greek letters,
// operators, super/subscripts, fractions, roots, and common commands.

const SYMBOLS: Record<string, string> = {
    // Greek (lowercase)
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
    varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ",
    varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
    // Greek (uppercase)
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
    Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    // Operators / relations
    times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", star: "⋆",
    leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
    equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
    // Logic / sets
    forall: "∀", exists: "∃", nexists: "∄", in: "∈", notin: "∉", ni: "∋",
    subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩",
    emptyset: "∅", varnothing: "∅", setminus: "∖", land: "∧", lor: "∨",
    lnot: "¬", neg: "¬", implies: "⟹", iff: "⟺", to: "→", rightarrow: "→",
    leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐",
    Leftrightarrow: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓",
    // Calculus / big ops
    sum: "∑", prod: "∏", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
    partial: "∂", nabla: "∇", infty: "∞", lim: "lim",
    // Misc
    sqrt: "√", angle: "∠", perp: "⊥", parallel: "∥", triangle: "△",
    cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱", prime: "′",
    hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", wp: "℘",
    circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗", odot: "⊙",
    langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
};

const SUPERSCRIPTS: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
    "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
    ")": "⁾", n: "ⁿ", i: "ⁱ", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ",
    x: "ˣ", y: "ʸ", T: "ᵀ",
};

const SUBSCRIPTS: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
    "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
    ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", n: "ₙ", x: "ₓ", o: "ₒ",
};

function mapScript(text: string, table: Record<string, string>): string | undefined {
    let out = "";
    for (const ch of text) {
        const mapped = table[ch];
        if (mapped === undefined) {
            return undefined;
        }
        out += mapped;
    }
    return out;
}

/** Render a single group following ^ or _, e.g. "2" or "{n+1}". */
function consumeScriptArg(src: string, index: number): { arg: string; next: number } {
    if (src[index] === "{") {
        const close = src.indexOf("}", index);
        if (close !== -1) {
            return { arg: src.slice(index + 1, close), next: close + 1 };
        }
    }
    return { arg: src[index] ?? "", next: index + 1 };
}

/** Convert a LaTeX math fragment into a best-effort Unicode string. */
export function latexToUnicode(input: string): string {
    let src = input.trim();

    // \frac{a}{b} → (a)/(b), repeatedly until none remain.
    const fracRe = /\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/;
    while (fracRe.test(src)) {
        src = src.replace(fracRe, (_m, a, b) => `(${a})/(${b})`);
    }

    // \sqrt{x} → √(x), \sqrt[n]{x} → ⁿ√(x)
    src = src.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_m, n, x) => {
        const sup = mapScript(n, SUPERSCRIPTS) ?? `[${n}]`;
        return `${sup}√(${x})`;
    });
    src = src.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, x) => `√(${x})`);

    // \text{...} / \mathrm{...} → contents verbatim.
    src = src.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1");

    // Named commands → symbols.
    src = src.replace(/\\([a-zA-Z]+)/g, (whole, name: string) => SYMBOLS[name] ?? whole);

    // Superscripts and subscripts.
    let out = "";
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if ((ch === "^" || ch === "_") && i + 1 < src.length) {
            const { arg, next } = consumeScriptArg(src, i + 1);
            const table = ch === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
            const mapped = mapScript(arg, table);
            if (mapped !== undefined) {
                out += mapped;
                i = next - 1;
                continue;
            }
            // Fall back to caret/underscore notation when we can't map cleanly.
            out += ch === "^" ? `^(${arg})` : `_(${arg})`;
            i = next - 1;
            continue;
        }
        out += ch;
    }

    // Tidy leftover braces and spacing commands.
    out = out.replace(/\\[,;:! ]/g, " ").replace(/[{}]/g, "").replace(/\\\\/g, " ");
    return out.replace(/\s+/g, " ").trim();
}

/**
 * Preprocess raw markdown, replacing `$...$` and `$$...$$` math with rendered
 * Unicode. Skips fenced/inline code so we don't mangle real `$` in code.
 */
export function renderMathInMarkdown(markdown: string): string {
    const segments = splitOutCode(markdown);
    return segments
        .map((seg) => (seg.code ? seg.text : replaceMath(seg.text)))
        .join("");
}

function replaceMath(text: string): string {
    // Display math first ($$...$$), then inline ($...$).
    let out = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => latexToUnicode(body));
    out = out.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_m, body: string) => latexToUnicode(body));
    // Also handle \( ... \) and \[ ... \].
    out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => latexToUnicode(body));
    out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => latexToUnicode(body));
    return out;
}

export interface Segment {
    text: string;
    code: boolean;
}

/** Split markdown into code and non-code segments so math/code don't collide. */
export function splitOutCode(markdown: string): Segment[] {
    const segments: Segment[] = [];
    const fenceRe = /(^```[\s\S]*?^```|`[^`\n]*`)/gm;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(markdown)) !== null) {
        if (match.index > last) {
            segments.push({ text: markdown.slice(last, match.index), code: false });
        }
        segments.push({ text: match[0], code: true });
        last = match.index + match[0].length;
    }
    if (last < markdown.length) {
        segments.push({ text: markdown.slice(last), code: false });
    }
    return segments;
}
