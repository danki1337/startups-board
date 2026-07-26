#!/usr/bin/env node
// Deterministic half of the product-design system (.claude/skills/product-design/).
//
// The skill carries judgement -- what a good empty state is, when a tooltip earns its place. This
// file carries only the rules a machine can decide, because a guideline nobody can check is a
// guideline that drifts. Each rule below exists because the thing it forbids actually shipped here
// at least once; the reference is in references/exemplars.md.
//
// Run: node tools/design-lint.mjs        (exits 1 on any error, 0 on warnings alone)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = "web/app/globals.css";
const SOURCES = ["web/app/jobs-explorer.tsx", "web/app/page.tsx", "web/app/layout.tsx", "web/app/ats-marks.tsx"];

// Rules that govern *our* design decisions, and the one file they do not apply to.
//
// ats-marks.tsx draws each ATS vendor's logo mark -- Greenhouse green, Workday orange, Ashby
// indigo. Those hexes are data, not design choices: they are the vendors' colours, they must not
// move when our palette does, and there is nothing to tokenize. The monogram sizing inside a 20px
// badge is likewise not on the page's type scale and should not be. Naming the exemption here is
// the point -- an unexplained blanket ignore is how a linter stops meaning anything.
const BRAND_ASSET_FILES = new Set(["web/app/ats-marks.tsx"]);

// The type scale. Anything outside it is drift -- a one-off size that nothing else on the page
// shares and no token explains. Tailwind's own text-sm/base/lg are fine; this governs the
// arbitrary-value escape hatch only.
// 12 is here for the two places that read as metadata rather than content -- the table's uppercase
// column header, and the "+N" locations badge beside it. Body text went to 14 deliberately; these
// two did not, because at 14 an uppercase tracked header competes with the rows underneath it.
const TYPE_SCALE = new Set([11, 12, 13, 14, 16, 18, 20, 24, 32, 42]);

const findings = [];
const report = (level, rule, file, line, message, fix) =>
  findings.push({ level, rule, file, line, message, fix });

const read = (path) => readFileSync(join(root, path), "utf8");

/* ---------------------------------------------------------------- design tokens */

// Every colour the design owns is declared once in globals.css. Parsing them here is what lets the
// linter tell "this hex has a token already" (drift, an error) from "this hex has no token yet"
// (a gap, a warning).
function designTokens() {
  const css = read(CSS);
  const tokens = new Map();
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens.set(value.toLowerCase(), name);
  }
  return tokens;
}

/* ------------------------------------------------------------------------ rules */

function lintSource(file, tokens) {
  const lines = read(file).split("\n");
  const brandAsset = BRAND_ASSET_FILES.has(file);

  lines.forEach((text, index) => {
    const line = index + 1;

    // R1/R2 -- colour literals. An arbitrary Tailwind value carrying a hex bypasses the token
    // system entirely, so a palette change silently misses it.
    //
    // Anywhere INSIDE the brackets, not filling them. The pattern used to be `\[(#hex)\]`, which
    // only ever saw a hex that was the whole arbitrary value -- so `text-[#868990]` was caught and
    // `shadow-[inset_0_0_0_1.5px_#FF73E5]` was not. Three focus rings kept the previous accent pink
    // through a change that replaced every other instance of it, and the linter whose entire job is
    // to catch that reported them clean.
    const arbitraryValues = brandAsset ? [] : [...text.matchAll(/\[([^\]]*)\]/g)];
    const hexes = arbitraryValues.flatMap((value) => [...value[1].matchAll(/#[0-9a-fA-F]{3,8}\b/g)]);
    for (const match of hexes) {
      const hex = match[0].toLowerCase();
      const token = tokens.get(hex);
      if (token) {
        report("error", "token-drift", file, line,
          `${match[0]} is already the token ${token}.`,
          `Use var(${token}) so a palette change reaches this too.`);
      } else {
        report("warn", "untokenized-color", file, line,
          `${match[0]} has no token in ${CSS}.`,
          "Promote it to a token, or reuse the nearest existing one.");
      }
    }

    // R3 -- hover must be instant. Colour transitions on hover were removed deliberately; they make
    // a dense table feel laggy because every row you sweep past animates.
    if (/transition-colors/.test(text)) {
      report("error", "hover-transition", file, line,
        "transition-colors animates hover feedback.",
        "Hover is instant here. Keep transitions for press-scale and enter animations only.");
    }

    // R4 -- the type scale.
    for (const match of brandAsset ? [] : text.matchAll(/text-\[(\d+)px\]/g)) {
      const size = Number(match[1]);
      if (!TYPE_SCALE.has(size)) {
        report("error", "type-scale", file, line,
          `${size}px is outside the type scale (${[...TYPE_SCALE].sort((a, b) => a - b).join(", ")}).`,
          "Pick the nearest scale step, or add the new step to TYPE_SCALE with a reason.");
      }
    }

    // R7 -- one weight. The page is set entirely at 700, and layout.tsx loads only that face, so a
    // stray font-medium or font-semibold does not render lighter -- font-synthesis is off and the
    // browser falls back to the nearest loaded weight, which is 700. It looks like a design decision
    // in the source and is a no-op on screen, which is the worst combination: the next person
    // "fixes" the hierarchy by adding more of them.
    for (const match of brandAsset ? [] : text.matchAll(/\bfont-(thin|extralight|light|normal|medium|semibold|extrabold|black)\b/g)) {
      report("error", "single-weight", file, line,
        `font-${match[1]} has no face loaded; it renders at 700 like everything else.`,
        "Use font-bold. To reintroduce a second weight, add it to the Nunito loader in layout.tsx first.");
    }

    // R6 -- a cropped value needs the measured tooltip, not the native title attribute. title only
    // appears on hover (never on keyboard focus) and cannot know whether the text was actually cut,
    // so it fires on values that fit and stays silent for keyboard users.
    if (/\btruncate\b/.test(text) && /\stitle=/.test(text)) {
      report("error", "truncation-tooltip", file, line,
        "A truncating element uses the native title attribute.",
        "Use useTruncationTip(): it measures scrollWidth first and shows on focus as well as hover.");
    }
  });

  // R5 -- an icon-only control needs an accessible name. Checked across the whole file rather than
  // per line, since the markup wraps.
  const source = read(file);
  for (const match of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [whole, attrs, inner] = match;
    const named = /\baria-label(?:ledby)?=|\btitle=/.test(attrs);
    // {children} / {label} are text supplied by the caller, so the button is not icon-only.
    const slotted = /\{\s*(children|label|value)\s*\}/.test(inner);
    const literalText = inner.replace(/<[^>]*>/g, " ").replace(/\{[^{}]*\}/g, " ");
    if (named || slotted || /[A-Za-z]{2,}/.test(literalText)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    report("error", "icon-button-name", file, line,
      `Icon-only button has no accessible name: ${whole.replace(/\s+/g, " ").slice(0, 70)}…`,
      "Add aria-label describing the action, not the glyph.");
  }
}

function lintStyles() {
  const lines = read(CSS).split("\n");
  lines.forEach((text, index) => {
    if (/transition:[^;]*\b(background-color|color)\b/.test(text)) {
      report("error", "hover-transition", CSS, index + 1,
        "Colour transition in CSS.",
        "Hover feedback is instant. Transition transform, opacity and size instead.");
    }
    // R7, the CSS half. Same reason as the utility rule: only 700 is loaded, so any other value
    // silently resolves to 700 and reads as intent that does not exist.
    const weight = /font-weight:\s*(\d+)/.exec(text);
    if (weight && weight[1] !== "700") {
      report("error", "single-weight", CSS, index + 1,
        `font-weight: ${weight[1]} has no face loaded; it renders at 700.`,
        "Use 700, or add the weight to the Nunito loader in layout.tsx first.");
    }
  });
}

/* ----------------------------------------------------------------------- output */

const tokens = designTokens();
for (const file of SOURCES) lintSource(file, tokens);
lintStyles();

const errors = findings.filter((f) => f.level === "error");
const warnings = findings.filter((f) => f.level === "warn");

for (const f of [...errors, ...warnings]) {
  const tag = f.level === "error" ? "ERROR" : " WARN";
  console.log(`${tag}  ${relative(".", f.file)}:${f.line}  [${f.rule}] ${f.message}`);
  console.log(`       -> ${f.fix}`);
}

const summary = `${errors.length} error(s), ${warnings.length} warning(s)`;
if (errors.length) {
  console.log(`\ndesign-lint: ${summary}`);
  process.exit(1);
}
console.log(`design-lint: ${summary}${warnings.length ? " (warnings do not fail the build)" : " — clean"}`);
