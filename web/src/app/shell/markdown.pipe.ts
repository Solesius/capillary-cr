// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { inject, Pipe, PipeTransform } from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";

/**
 * Minimal, XSS-safe Markdown → HTML renderer for previewing RetV run reports.
 *
 * The app ships no markdown dependency, so this renders a deliberately small,
 * GitHub-flavoured subset (headings, bold/italic, inline + fenced code, lists,
 * tables, blockquotes, hr, links). Security model: every input character is
 * HTML-escaped FIRST, then only our own known-safe tags are introduced, so the
 * resulting string is safe to trust. Links are restricted to http/https/mailto.
 */
@Pipe({ name: "capMarkdown", standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(value ?? ""));
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first so its contents are not further transformed.
  const codeStore: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeStore.push(`<code>${code}</code>`);
    return `\u0000${codeStore.length - 1}\u0000`;
  });
  // Links [text](url) — only safe schemes.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    if (/^(https?:|mailto:)/i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeStore[Number(index)]);
  return out;
}

function renderTable(rows: string[]): string {
  const cells = (line: string): string[] =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  const header = cells(rows[0]);
  const bodyRows = rows.slice(2); // skip the `--- | ---` separator
  const head = `<tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr>`;
  const body = bodyRows
    .map((row) => `<tr>${cells(row).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="cap-md-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line.trim())) {
      closeList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      html.push(`<pre class="cap-md-pre"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Table block: a header row followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList();
      const block: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        block.push(lines[i]);
        i++;
      }
      html.push(renderTable(block));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level} class="cap-md-h${level}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      html.push(`<hr class="cap-md-hr" />`);
      i++;
      continue;
    }

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        html.push(`<ul class="cap-md-list">`);
        listType = "ul";
      }
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      i++;
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html.push(`<ol class="cap-md-list">`);
        listType = "ol";
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      i++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      html.push(`<blockquote class="cap-md-quote">${renderInline(quote[1])}</blockquote>`);
      i++;
      continue;
    }

    if (line.trim().length === 0) {
      closeList();
      i++;
      continue;
    }

    closeList();
    html.push(`<p class="cap-md-p">${renderInline(line)}</p>`);
    i++;
  }

  closeList();
  return html.join("\n");
}
