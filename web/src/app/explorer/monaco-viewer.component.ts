// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Read-only Monaco file viewer for the explorer fly-out. Monaco is loaded
// lazily (dynamic import → its own chunk) the first time a file is opened, so
// the main bundle stays lean. Findings anchored to the open file render as
// bespoke Carbon-style cards injected as Monaco view zones directly under
// their line — sharp corners, severity accent bar, mono labels; deliberately
// not a GitHub-comment lookalike.

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  viewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type * as Monaco from "monaco-editor";
import { ReviewFinding } from "../models";

type MonacoModule = typeof Monaco;

let monacoLoader: Promise<MonacoModule> | null = null;

/** Load Monaco once per session; every viewer instance shares the module. */
function loadMonaco(): Promise<MonacoModule> {
  if (!monacoLoader) {
    // Editor-core worker only: the viewer is read-only with language smarts
    // disabled, so no TS/JSON/CSS language workers are shipped.
    (globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () =>
        new Worker(
          // Relative node_modules path: the bundler resolves `new URL` against
          // this file, not the package graph, so a bare specifier won't do.
          new URL(
            "../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        ),
    };
    monacoLoader = import("monaco-editor").then((monaco) => {
      monaco.editor.defineTheme("capillary-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#0d1526",
          "editor.lineHighlightBackground": "#16203a",
          "editorLineNumber.foreground": "#3d4d6e",
          "editorLineNumber.activeForeground": "#8b9cc0",
          "editorGutter.background": "#0d1526",
        },
      });
      return monaco;
    });
  }
  return monacoLoader;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  sql: "sql",
  xml: "xml",
  kt: "kotlin",
  swift: "swift",
};

function languageForPath(path: string): string {
  const base = path.split("/").at(-1) ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "ini";
  return EXT_LANGUAGE[base.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

@Component({
  selector: "app-monaco-viewer",
  standalone: true,
  imports: [CommonModule],
  template: `<div #host class="cap-monaco-host"></div>`,
  styles: [`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .cap-monaco-host {
      height: 100%;
      min-height: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MonacoViewerComponent implements OnDestroy {
  readonly path = input.required<string>();
  readonly content = input.required<string>();
  readonly findings = input<ReviewFinding[]>([]);
  readonly revealLine = input<number | null>(null);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>("host");
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: MonacoModule | null = null;
  private decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  private zoneIds: string[] = [];
  private disposed = false;

  constructor() {
    effect(() => {
      // Track all render inputs, then hand off to the async renderer.
      const path = this.path();
      const content = this.content();
      const findings = this.findings();
      const reveal = this.revealLine();
      void this.render(path, content, findings, reveal);
    });
  }

  private async render(
    path: string,
    content: string,
    findings: ReviewFinding[],
    reveal: number | null,
  ): Promise<void> {
    const monaco = this.monaco ?? (this.monaco = await loadMonaco());
    if (this.disposed) return;

    if (!this.editor) {
      this.editor = monaco.editor.create(this.host().nativeElement, {
        readOnly: true,
        domReadOnly: true,
        theme: "capillary-dark",
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        lineNumbersMinChars: 4,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        occurrencesHighlight: "off",
        selectionHighlight: false,
        contextmenu: false,
        links: false,
        hover: { enabled: false },
        quickSuggestions: false,
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
      });
    }

    const uri = monaco.Uri.parse(`capillary://review/${encodeURIComponent(path)}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, languageForPath(path), uri);
    } else if (model.getValue() !== content) {
      model.setValue(content);
    }
    if (this.editor.getModel() !== model) {
      this.editor.setModel(model);
    }

    this.applyFindings(monaco, model, findings);

    if (reveal !== null && reveal > 0) {
      this.editor.revealLineInCenter(Math.min(reveal, model.getLineCount()));
      this.editor.setPosition({ lineNumber: Math.min(reveal, model.getLineCount()), column: 1 });
    }
  }

  /** Line decorations + a bespoke Carbon card view-zone under each finding. */
  private applyFindings(
    monaco: MonacoModule,
    model: Monaco.editor.ITextModel,
    findings: ReviewFinding[],
  ): void {
    const editor = this.editor;
    if (!editor) return;

    const anchored = findings
      .filter((finding) => typeof finding.line === "number" && finding.line > 0)
      .map((finding) => ({
        ...finding,
        line: Math.min(finding.line as number, model.getLineCount()),
      }));

    this.decorations?.clear();
    this.decorations = editor.createDecorationsCollection(anchored.map((finding) => ({
      range: new monaco.Range(finding.line, 1, finding.line, 1),
      options: {
        isWholeLine: true,
        className: `cap-fz-line cap-fz-line--${finding.severity}`,
        linesDecorationsClassName: `cap-fz-gutter cap-fz-gutter--${finding.severity}`,
      },
    })));

    editor.changeViewZones((accessor) => {
      for (const id of this.zoneIds) {
        accessor.removeZone(id);
      }
      this.zoneIds = anchored.map((finding) => {
        const node = document.createElement("div");
        node.className = "cap-fz";
        node.innerHTML = `
          <article class="cap-fz-card cap-fz-card--${finding.severity}">
            <header class="cap-fz-head">
              <span class="cap-fz-sev">${escapeHtml(finding.severity)}</span>
              <span class="cap-fz-gate">${escapeHtml(finding.passName)} gate</span>
              <span class="cap-fz-conf">confidence ${
          Number.isFinite(finding.confidence) ? finding.confidence.toFixed(2) : "—"
        }</span>
            </header>
            <h4 class="cap-fz-title">${escapeHtml(finding.title)}</h4>
            <p class="cap-fz-body">${escapeHtml(finding.finding)}</p>
            ${
          finding.suggestedFix
            ? `<p class="cap-fz-fix"><span>Fix</span> ${escapeHtml(finding.suggestedFix)}</p>`
            : ""
        }
          </article>`;
        // View zones need an explicit height; estimate from body length at the
        // card's measure (~92ch/line) and clamp so a long narrative cannot
        // swallow the viewport.
        const bodyLines = Math.ceil(finding.finding.length / 92) +
          (finding.suggestedFix ? Math.ceil(finding.suggestedFix.length / 92) : 0);
        return accessor.addZone({
          afterLineNumber: finding.line,
          heightInPx: Math.min(96 + bodyLines * 17, 260),
          domNode: node,
        });
      });
    });
  }

  ngOnDestroy(): void {
    this.disposed = true;
    this.decorations?.clear();
    this.editor?.dispose();
    this.editor = null;
  }
}
