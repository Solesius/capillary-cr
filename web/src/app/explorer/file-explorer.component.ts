// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Left fly-out file explorer. The tree map comes from the PR's cached diff
// (zero extra GitHub calls); file bodies load one at a time on click and are
// session-cached in the store, so browsing can never fan out into a rate-limit
// burst. Findings deep-link here and render as Carbon cards inside the viewer.

import { ChangeDetectionStrategy, Component, computed, HostListener, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { CapillaryStore } from "../state/capillary.store";
import { PullRequestDiffFile } from "../models";
import { MonacoViewerComponent } from "./monaco-viewer.component";

interface ExplorerDirGroup {
  dir: string;
  files: PullRequestDiffFile[];
}

const STATUS_GLYPH: Record<PullRequestDiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

@Component({
  selector: "app-file-explorer",
  standalone: true,
  imports: [CommonModule, MonacoViewerComponent],
  template: `
    @if (store.explorerOpen()) {
      <div class="cap-fx-backdrop" (click)="store.closeExplorer()"></div>
    }
    <aside class="cap-fx" [class.open]="store.explorerOpen()" aria-label="File explorer">
      <header class="cap-fx-head">
        <div class="cap-fx-head-title">
          <span class="cap-fx-label">File Explorer</span>
          <span class="cap-fx-sub">{{ store.selectedPullRequest()?.title || 'no PR selected' }}</span>
        </div>
        <button class="cap-button cap-button-ghost cap-button-sm" type="button" (click)="store.closeExplorer()">
          Close ✕
        </button>
      </header>

      <div class="cap-fx-body">
        <nav class="cap-fx-tree" aria-label="Changed files">
          @if (groups().length === 0) {
            <p class="cap-fx-empty">No file map yet — select a PR and open a review.</p>
          }
          @for (group of groups(); track group.dir) {
            <p class="cap-fx-dir">{{ group.dir }}</p>
            @for (file of group.files; track file.path) {
              <button
                type="button"
                class="cap-fx-row"
                [class.active]="store.explorerActivePath() === file.path"
                [disabled]="file.status === 'deleted'"
                (click)="openFile(file)">
                <span class="cap-fx-glyph" [attr.data-status]="file.status">{{ glyph(file) }}</span>
                <span class="cap-fx-name">{{ basename(file.path) }}</span>
                @if (findingCount(file.path); as count) {
                  <span class="cap-fx-findings">{{ count }}</span>
                }
                <span class="cap-fx-churn">+{{ file.additions }} −{{ file.deletions }}</span>
              </button>
            }
          }
        </nav>

        <section class="cap-fx-view">
          @if (store.explorerError(); as error) {
            <p class="cap-fx-state cap-fx-state--error">{{ error }}</p>
          } @else if (store.explorerLoading()) {
            <p class="cap-fx-state">Loading {{ store.explorerActivePath() }}…</p>
          } @else if (store.explorerActivePath() && store.explorerContent() !== null) {
            <app-monaco-viewer
              [path]="store.explorerActivePath()!"
              [content]="store.explorerContent()!"
              [findings]="store.explorerFindings()"
              [revealLine]="store.explorerRevealLine()" />
          } @else {
            <p class="cap-fx-state">Pick a file — contents load on demand, findings render in place.</p>
          }
        </section>
      </div>
    </aside>
  `,
  styles: [`
    .cap-fx-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(4, 8, 16, 0.55);
      z-index: 70;
    }
    .cap-fx {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: min(880px, 92vw);
      display: flex;
      flex-direction: column;
      background: var(--cap-bg, #0b1220);
      border-right: 1px solid var(--cap-border, #24304a);
      transform: translateX(-102%);
      transition: transform 160ms cubic-bezier(0.2, 0, 0.38, 0.9);
      z-index: 71;
    }
    .cap-fx.open { transform: translateX(0); }
    .cap-fx-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--cap-border, #24304a);
    }
    .cap-fx-head-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cap-fx-label {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cap-muted, #7f8db0);
    }
    .cap-fx-sub {
      font-size: 0.85rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cap-fx-body { display: flex; flex: 1; min-height: 0; }
    .cap-fx-tree {
      width: 264px;
      flex: none;
      overflow-y: auto;
      border-right: 1px solid var(--cap-border, #24304a);
      padding: 8px 0 16px;
    }
    .cap-fx-dir {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cap-muted, #7f8db0);
      padding: 10px 14px 4px;
      margin: 0;
    }
    .cap-fx-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 14px;
      background: none;
      border: none;
      border-left: 2px solid transparent;
      color: inherit;
      font: inherit;
      font-size: 0.8rem;
      text-align: left;
      cursor: pointer;
    }
    .cap-fx-row:hover { background: rgba(125, 155, 220, 0.07); }
    .cap-fx-row.active {
      border-left-color: var(--cap-accent, #4c9aff);
      background: rgba(76, 154, 255, 0.09);
    }
    .cap-fx-row:disabled { opacity: 0.45; cursor: not-allowed; }
    .cap-fx-glyph {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.68rem;
      width: 14px;
      flex: none;
      color: var(--cap-muted, #7f8db0);
    }
    .cap-fx-glyph[data-status="added"] { color: #42be65; }
    .cap-fx-glyph[data-status="deleted"] { color: #fa4d56; }
    .cap-fx-glyph[data-status="modified"] { color: #f1c21b; }
    .cap-fx-name {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cap-fx-findings {
      flex: none;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.66rem;
      padding: 0 5px;
      border: 1px solid var(--cap-accent, #4c9aff);
      color: var(--cap-accent, #4c9aff);
    }
    .cap-fx-churn {
      flex: none;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.64rem;
      color: var(--cap-muted, #7f8db0);
    }
    .cap-fx-view { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .cap-fx-state { margin: auto; padding: 24px; color: var(--cap-muted, #7f8db0); font-size: 0.85rem; }
    .cap-fx-state--error { color: #fa4d56; }
    .cap-fx-empty { padding: 14px; color: var(--cap-muted, #7f8db0); font-size: 0.8rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileExplorerComponent {
  readonly store = inject(CapillaryStore);

  readonly groups = computed<ExplorerDirGroup[]>(() => {
    const byDir = new Map<string, PullRequestDiffFile[]>();
    for (const file of this.store.explorerFiles()) {
      const slash = file.path.lastIndexOf("/");
      const dir = slash === -1 ? "/" : file.path.slice(0, slash);
      const bucket = byDir.get(dir);
      if (bucket) {
        bucket.push(file);
      } else {
        byDir.set(dir, [file]);
      }
    }
    return [...byDir.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dir, files]) => ({
        dir,
        files: files.slice().sort((a, b) => a.path.localeCompare(b.path)),
      }));
  });

  @HostListener("document:keydown.escape")
  onEscape(): void {
    if (this.store.explorerOpen()) {
      this.store.closeExplorer();
    }
  }

  openFile(file: PullRequestDiffFile): void {
    void this.store.openFileInExplorer(file.path);
  }

  basename(path: string): string {
    return path.split("/").at(-1) ?? path;
  }

  glyph(file: PullRequestDiffFile): string {
    return STATUS_GLYPH[file.status] ?? "M";
  }

  findingCount(path: string): number {
    return this.store.findings().filter((finding) => finding.filePath === path).length;
  }
}
