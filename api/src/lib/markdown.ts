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

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const TAG = /<\/?[A-Za-z][^<>\n]*>/g;

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
    const close = line.indexOf(run, tick + run.length);
    if (close === -1) {
      out += line.slice(tick);
      break;
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
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[2][0] === fence[0] && opener[2].length >= fence.length) fence = null;
      return line;
    }
    if (opener) {
      fence = opener[2];
      return line;
    }
    return quoteTagsInLine(line);
  }).join("\n");
}
