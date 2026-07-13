// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Read-only Monaco file viewer for the explorer fly-out. Monaco is loaded
// lazily (dynamic import → its own chunk) the first time a file is opened, so
// the main bundle stays lean. Two modes: plain read, and a side-by-side diff
// of base (target branch) vs head. Findings anchored to the open file render
// as bespoke Carbon-style cards injected as Monaco view zones directly under
// their line — sharp corners, severity accent bar, mono labels; deliberately
// not a GitHub-comment lookalike. Theme tracks the app's html[data-theme]
// attribute live, with first-class palettes for both light and dark.

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  OnDestroy,
  signal,
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
          "diffEditor.insertedTextBackground": "#42be6522",
          "diffEditor.removedTextBackground": "#fa4d5622",
          "diffEditor.insertedLineBackground": "#42be6514",
          "diffEditor.removedLineBackground": "#fa4d5614",
        },
      });
      monaco.editor.defineTheme("capillary-light", {
        base: "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#fcfdff",
          "editor.lineHighlightBackground": "#eef2f9",
          "editorLineNumber.foreground": "#9aa7bd",
          "editorLineNumber.activeForeground": "#334155",
          "editorGutter.background": "#fcfdff",
          "diffEditor.insertedTextBackground": "#0f766e1f",
          "diffEditor.removedTextBackground": "#dc26261a",
          "diffEditor.insertedLineBackground": "#0f766e10",
          "diffEditor.removedLineBackground": "#dc26260e",
        },
      });
      return monaco;
    });
  }
  return monacoLoader;
}

function activeMonacoTheme(): string {
  return document.documentElement.dataset["theme"] === "dark"
    ? "capillary-dark"
    : "capillary-light";
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

const SHARED_EDITOR_OPTIONS: Monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
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
};

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
  /** Side-by-side base vs head; requires baseContent to be loaded. */
  readonly diffMode = input(false);
  readonly baseContent = input<string | null>(null);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>("host");
  private readonly theme = signal(activeMonacoTheme());
  private readonly themeObserver: MutationObserver;
  private monaco: MonacoModule | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  private zoneIds: string[] = [];
  private disposed = false;

  constructor() {
    // Track the app theme live: the shell writes html[data-theme] on toggle.
    this.themeObserver = new MutationObserver(() => this.theme.set(activeMonacoTheme()));
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    effect(() => {
      const theme = this.theme();
      if (this.monaco) {
        this.monaco.editor.setTheme(theme);
      }
    });

    effect(() => {
      // Track all render inputs, then hand off to the async renderer.
      const path = this.path();
      const content = this.content();
      const findings = this.findings();
      const reveal = this.revealLine();
      const diff = this.diffMode();
      const base = this.baseContent();
      void this.render(path, content, findings, reveal, diff, base);
    });
  }

  private async render(
    path: string,
    content: string,
    findings: ReviewFinding[],
    reveal: number | null,
    diffMode: boolean,
    baseContent: string | null,
  ): Promise<void> {
    const monaco = this.monaco ?? (this.monaco = await loadMonaco());
    if (this.disposed) return;
    monaco.editor.setTheme(this.theme());

    const useDiff = diffMode && baseContent !== null;
    const modified = this.model(
      monaco,
      `capillary://head/${encodeURIComponent(path)}`,
      path,
      content,
    );

    if (useDiff) {
      this.teardownPlainEditor();
      if (!this.diffEditor) {
        this.diffEditor = monaco.editor.createDiffEditor(this.host().nativeElement, {
          ...SHARED_EDITOR_OPTIONS,
          renderSideBySide: true,
          renderOverviewRuler: false,
          diffWordWrap: "off",
        });
      }
      const original = this.model(
        monaco,
        `capillary://base/${encodeURIComponent(path)}`,
        path,
        baseContent,
      );
      const current = this.diffEditor.getModel();
      if (current?.original !== original || current?.modified !== modified) {
        this.diffEditor.setModel({ original, modified });
      }
      const target = this.diffEditor.getModifiedEditor();
      this.applyFindings(monaco, target, modified, findings);
      this.revealIn(target, modified, reveal);
      return;
    }

    this.teardownDiffEditor();
    if (!this.editor) {
      this.editor = monaco.editor.create(this.host().nativeElement, {
        ...SHARED_EDITOR_OPTIONS,
        theme: this.theme(),
      });
    }
    if (this.editor.getModel() !== modified) {
      this.editor.setModel(modified);
    }
    this.applyFindings(monaco, this.editor, modified, findings);
    this.revealIn(this.editor, modified, reveal);
  }

  private model(
    monaco: MonacoModule,
    uriText: string,
    path: string,
    content: string,
  ): Monaco.editor.ITextModel {
    const uri = monaco.Uri.parse(uriText);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, languageForPath(path), uri);
    } else if (model.getValue() !== content) {
      model.setValue(content);
    }
    return model;
  }

  private revealIn(
    editor: Monaco.editor.IStandaloneCodeEditor,
    model: Monaco.editor.ITextModel,
    reveal: number | null,
  ): void {
    if (reveal !== null && reveal > 0) {
      const line = Math.min(reveal, model.getLineCount());
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
  }

  private teardownPlainEditor(): void {
    this.decorations?.clear();
    this.decorations = null;
    this.zoneIds = [];
    this.editor?.dispose();
    this.editor = null;
  }

  private teardownDiffEditor(): void {
    if (this.diffEditor) {
      this.decorations?.clear();
      this.decorations = null;
      this.zoneIds = [];
      this.diffEditor.dispose();
      this.diffEditor = null;
    }
  }

  /** Line decorations + a bespoke Carbon card view-zone under each finding. */
  private applyFindings(
    monaco: MonacoModule,
    editor: Monaco.editor.IStandaloneCodeEditor,
    model: Monaco.editor.ITextModel,
    findings: ReviewFinding[],
  ): void {
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
    this.themeObserver.disconnect();
    this.teardownPlainEditor();
    this.teardownDiffEditor();
  }
}
