// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// markdown.ts — make model-written prose safe to post as host markdown.
//
// Review text routinely names HTML elements ("the <title> tag"). Posted raw,
// GitHub's sanitizer silently drops the tag and GitLab's treats elements like
// <title> or <textarea> as raw text containers that swallow the rest of the
// comment. Tag-shaped tokens outside code are therefore wrapped in inline code,
// which both hosts render literally. Fenced blocks and existing code spans are
// left untouched, so suggestion code is never altered.
//
// Known limits, all of which err toward quoting (cosmetic, never unsafe):
// inline code spans that cross a line break are not recognised; fences nested
// in list items (indented four or more spaces) are read as prose; and
// tag-shaped text that is not a tag, such as `x<y and z>w`, is quoted.

// CommonMark fences: at most three spaces of indent. A closer is a run of the
// same character, at least as long as the opener, followed only by whitespace.
// A backtick fence's info string cannot contain a backtick: "```<p>``` …" at
// the start of a line is an inline code span, not a fence.
const FENCE_OPEN = /^ {0,3}(?:(`{3,})(?!.*`)|(~{3,}))/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// A real tag name, then attributes or the end: `<title>`, `</div>`, `<br/>`,
// `<a href="x">`. Autolinks (`<https://…>`, `<user@host>`) do not match.
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g;

/** Index of the next backtick run of exactly `length` at or after `from`, or -1. */
function closingRun(line: string, from: number, length: number): number {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let match = runs.exec(line); match; match = runs.exec(line)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

/** Quote tag-shaped tokens in one line, skipping existing inline code spans. */
function quoteTagsInLine(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const tick = line.indexOf("`", index);
    const prose = tick === -1 ? line.slice(index) : line.slice(index, tick);
    // Prose never contains a backtick here (spans are split out), so one suffices.
    out += prose.replace(TAG, (tag) => `\`${tag}\``);
    if (tick === -1) break;
    // An inline code span: a run of N backticks closed by the next run of exactly N.
    const run = /^`+/.exec(line.slice(tick))![0];
    const close = closingRun(line, tick + run.length, run.length);
    if (close === -1) {
      // An unmatched backtick run is literal text; keep protecting what follows.
      out += run;
      index = tick + run.length;
      continue;
    }
    out += line.slice(tick, close + run.length);
    index = close + run.length;
  }
  return out;
}

/**
 * Prose from the model, ready to embed in a GitHub or GitLab comment: HTML-like
 * tags outside code become inline code; fenced code blocks pass through as-is.
 */
export function markdownProse(text: string): string {
  let fence: string | null = null;
  return text.split("\n").map((line) => {
    if (fence) {
      const closer = FENCE_CLOSE.exec(line);
      if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length) fence = null;
      return line;
    }
    const opener = FENCE_OPEN.exec(line);
    if (opener) {
      fence = opener[1] ?? opener[2];
      return line;
    }
    return quoteTagsInLine(line);
  }).join("\n");
}
