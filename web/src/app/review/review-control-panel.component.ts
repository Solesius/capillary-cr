// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { ApiClientService } from "../services/api-client.service";
import { CapillaryStore } from "../state/capillary.store";
import { ReviewPhase, TCSRTC_GATES, toReviewPhase } from "../models";
import { MarkdownPipe } from "../shell/markdown.pipe";
import { ReviewFindingsPanelComponent } from "./review-findings-panel.component";

@Component({
  selector: "app-review-control-panel",
  standalone: true,
  imports: [CommonModule, MarkdownPipe, ReviewFindingsPanelComponent],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>Review Control</span>
        <span class="cap-chip" [attr.data-state]="reviewStatus()">{{ statusLabel(reviewStatus()) }}</span>
      </header>
      <div class="cap-panel-body">
        <p class="cap-muted">Target → Constrain → Sanitize → Review → Test → Confirm. The agent narrates each gate below; the final report renders when the run completes.</p>

        <div class="cap-gate-rail" style="margin-top: 12px;">
          @for (gate of gates; track gate) {
            <span
              class="cap-gate-chip"
              [class.covered]="store.reviewGatesCovered().includes(gate)"
              [class.current]="store.reviewCurrentGate() === gate">
              {{ gate }}
            </span>
          }
        </div>

        <div class="cap-progress" [class.working]="agentWorking()" style="margin-top: 12px;">
          <span [style.width.%]="store.progress()"></span>
        </div>
        <div class="cap-row" style="margin-top: 8px;">
          <p class="cap-muted">{{ store.progress() }}%</p>
          @if (runElapsedLabel(); as elapsed) {
            <p class="cap-muted cap-mono-inline">run {{ elapsed }}</p>
          }
          <p class="cap-muted cap-mono-inline">{{ phaseLabel() }}</p>
        </div>

        <div class="cap-row" style="margin-top: 14px;">
          <button
            class="cap-button cap-button-primary"
            [class.busy]="starting()"
            [disabled]="!store.canBegin() || starting()"
            (click)="beginReview()">
            {{ store.selectedReviewInProgress() ? 'Review in progress…' : 'Begin Review' }}
          </button>
          <button
            class="cap-button"
            [disabled]="!store.canCancel()"
            (click)="cancelReview()">
            Stop
          </button>
        </div>

        <div class="cap-run-options">
          <p class="cap-run-options-label">Run Options</p>
          <label class="cap-option-row">
            <input
              type="checkbox"
              [checked]="store.reviewTraceEnabled()"
              (change)="onTraceToggle($event)" />
            <span class="cap-option-name">Trace review</span>
            <span class="cap-option-hint">Retain tool trace + capture bundle</span>
          </label>
          <label class="cap-option-row">
            <input
              type="checkbox"
              [checked]="store.reviewSuggestEnabled()"
              (change)="onSuggestToggle($event)" />
            <span class="cap-option-name">Suggestions</span>
            <span class="cap-option-hint">Allow committable code fixes (more tokens)</span>
          </label>
        </div>

        @if (store.selectedPullRequest()) {
          <div class="cap-card" style="margin-top: 14px;">
            <p class="cap-stat-label">Selected Pull Request</p>
            <p style="margin-top: 4px; font-weight: 600;">{{ store.selectedPullRequest()?.title }}</p>
          </div>
        }

        @if (store.reviewSessions().length > 0) {
          <div class="cap-session-strip" style="margin-top: 14px;">
            @for (session of store.reviewSessions(); track session.runId) {
              <button
                type="button"
                class="cap-session-chip"
                [class.current]="session.runId === store.activeSessionRunId()"
                (click)="switchSession(session.runId)"
                [attr.title]="session.active ? 'Running — click to view' : 'Finished — click to view'">
                <span class="cap-session-dot" [class.live]="session.active"></span>
                <span class="cap-session-id">{{ session.runId.slice(-6) }}</span>
                <span class="cap-session-state">{{ session.active ? 'running' : 'done' }}</span>
              </button>
            }
          </div>
        }

        <div class="cap-activity-head" style="margin-top: 14px;">
          <div class="cap-row">
            <strong>Live Review Output</strong>
            <div class="cap-row" style="gap: 10px;">
              @if (store.reviewTokensUsed() > 0) {
                <span class="cap-token-meter" title="Model tokens — input / output / total for this run">
                  <span class="cap-token-seg"><span class="cap-token-label">in</span><span class="cap-token-value">{{ store.reviewInputTokens() | number }}</span></span>
                  <span class="cap-token-seg"><span class="cap-token-label">out</span><span class="cap-token-value">{{ store.reviewOutputTokens() | number }}</span></span>
                  <span class="cap-token-seg cap-token-total"><span class="cap-token-label">total</span><span class="cap-token-value">{{ store.reviewTokensUsed() | number }}</span></span>
                </span>
              }
              <span class="cap-live-chip" [class.active]="agentWorking()">
                <span class="cap-live-dot"></span>
                @if (agentWorking()) {
                  cycling
                  <span class="cap-thinking-dots"><i></i><i></i><i></i></span>
                } @else {
                  idle
                }
              </span>
            </div>
          </div>
        </div>

        @if (store.newSessionWarningVisible()) {
          <div class="cap-modal-backdrop" (click)="dismissWarning()">
            <div class="cap-modal-card" (click)="$event.stopPropagation()">
              <div class="cap-modal-glyph">⚡</div>
              <h3 class="cap-modal-title">Start another session?</h3>
              <p class="cap-modal-body">
                {{ runningCount() }} review session{{ runningCount() === 1 ? ' is' : 's are' }} still running.
                Each concurrent session drives its own model — <strong>tokens, rate limits, and
                provider costs stack per session</strong>. Running sessions keep going either way.
              </p>
              <div class="cap-modal-actions">
                <button class="cap-button" type="button" (click)="dismissWarning()">Cancel</button>
                <button class="cap-button cap-button-primary" type="button" (click)="confirmNewSession()">
                  Run concurrent session
                </button>
              </div>
            </div>
          </div>
        }

        @if (showFinalOutput()) {
          <div class="cap-review-output-shell cap-review-output-final">
            <div class="cap-review-output-head">
              <div class="cap-review-output-empty">
                <strong>Final review output</strong>
                <span class="cap-muted">The completed report is now rendered below.</span>
              </div>
              @if (store.prCommentState() === 'posted') {
                <a
                  class="cap-button cap-button-ghost cap-button-sm"
                  [href]="store.prCommentUrl()"
                  target="_blank"
                  rel="noopener">
                  Posted ✓ — view on GitHub
                </a>
              } @else {
                <button
                  class="cap-button cap-button-sm"
                  type="button"
                  [disabled]="store.prCommentState() === 'posting'"
                  (click)="postToPr()">
                  {{ store.prCommentState() === 'posting' ? 'Posting…' : store.prCommentState() === 'failed' ? 'Retry post to PR' : 'Post summary to PR' }}
                </button>
              }
              <button
                class="cap-button cap-button-ghost cap-button-sm"
                type="button"
                (click)="store.downloadSelectedReviewReport()">
                Download report (.md)
              </button>
              @if (store.selectedReviewTraceEnabled()) {
                <button
                  class="cap-button cap-button-ghost cap-button-sm"
                  type="button"
                  (click)="store.exportSelectedReview()">
                  Export trace bundle (.zip)
                </button>
              } @else {
                <span class="cap-option-hint">Run not traced — enable “Trace review” for bundle export.</span>
              }
            </div>
            <div class="cap-md-report" [innerHTML]="store.reviewReport() | capMarkdown"></div>
            <app-review-findings-panel />
          </div>
        } @else {
          @if (narrative().length === 0) {
            <div class="cap-review-output-shell">
              <div class="cap-review-output-empty">
                <strong>Waiting.</strong>
                <span class="cap-muted">Select a PR and begin a review.</span>
              </div>
            </div>
          } @else {
            <div class="cap-review-output-shell cap-narrative cap-console">
              @for (entry of narrative(); track entry.id) {
                <div class="cap-con-row" [attr.data-kind]="entry.kind" [attr.data-severity]="entry.severity">
                  <span class="cap-con-badge">{{ badgeFor(entry) }}</span>
                  <div class="cap-con-body">
                    @switch (entry.kind) {
                      @case ('thinking') {
                        <span class="cap-con-text">{{ entry.text }}</span>
                      }
                      @case ('tool') {
                        <span class="cap-con-mono">{{ entry.tool }}</span>
                        <span class="cap-con-dim">{{ entry.text }}</span>
                      }
                      @case ('finding') {
                        <span class="cap-con-sev">{{ entry.severity }}</span>
                        <span class="cap-con-text">{{ entry.text }}</span>
                      }
                      @case ('gate') {
                        <span class="cap-con-mono">{{ entry.gate }}</span>
                        <span class="cap-con-dim">cycle {{ entry.cycle }} · {{ entry.text }}</span>
                      }
                      @default {
                        <span class="cap-con-text">{{ entry.text }}</span>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          }
        }
      </div>
    </section>
  `,
  styles: [`
    .cap-review-output-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .cap-review-output-head .cap-button-sm { white-space: nowrap; }

    .cap-session-strip {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cap-session-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 11px;
      border-radius: 3px;
      border: 1px solid var(--cap-border);
      background: var(--cap-surface-raised);
      color: var(--cap-muted);
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.18s, color 0.18s, transform 0.12s;
    }
    .cap-session-chip:hover { transform: translateY(-1px); border-color: var(--cap-primary-line); }
    .cap-session-chip.current {
      border-color: var(--cap-accent);
      color: var(--cap-text);
      box-shadow: 0 0 0 1px rgba(var(--cap-accent-rgb), 0.25);
    }
    .cap-session-id { font-family: var(--cap-mono, monospace); letter-spacing: 0.03em; }
    .cap-session-state { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.75; }
    .cap-session-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--cap-muted);
      opacity: 0.5;
    }
    .cap-session-dot.live {
      background: var(--cap-ok);
      opacity: 1;
      animation: cap-session-pulse 1.6s ease-in-out infinite;
    }
    @keyframes cap-session-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(15, 118, 110, 0.45); }
      50% { box-shadow: 0 0 0 5px rgba(15, 118, 110, 0); }
    }

    .cap-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(8, 12, 20, 0.55);
      backdrop-filter: blur(6px);
      animation: cap-modal-fade 0.16s ease-out;
    }
    .cap-modal-card {
      width: min(440px, calc(100vw - 48px));
      padding: 26px 26px 22px;
      border-radius: 6px;
      border: 1px solid var(--cap-border);
      background: var(--cap-surface, #0e1420);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
      animation: cap-modal-rise 0.18s cubic-bezier(0.21, 1.02, 0.73, 1);
    }
    .cap-modal-glyph {
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border-radius: 4px;
      border: 1px solid var(--cap-border);
      background: var(--cap-surface-raised);
      font-size: 1.1rem;
      margin-bottom: 14px;
    }
    .cap-modal-title {
      margin: 0 0 8px;
      font-size: 1.02rem;
      letter-spacing: -0.01em;
    }
    .cap-modal-body {
      margin: 0;
      font-size: 0.85rem;
      line-height: 1.55;
      color: var(--cap-muted);
    }
    .cap-modal-body strong { color: var(--cap-text); }
    .cap-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
    }
    @keyframes cap-modal-fade { from { opacity: 0; } }
    @keyframes cap-modal-rise { from { opacity: 0; transform: translateY(10px) scale(0.98); } }

    .cap-gate-rail {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cap-gate-chip {
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 3px 9px;
      border-radius: 3px;
      border: 1px solid var(--cap-border);
      color: var(--cap-muted);
      background: transparent;
      transition: border-color 0.2s, color 0.2s, background 0.2s;
    }
    .cap-gate-chip.covered {
      border-color: var(--cap-ok);
      color: var(--cap-ok);
      background: rgba(15, 118, 110, 0.08);
    }
    .cap-gate-chip.current {
      border-color: var(--cap-accent);
      color: var(--cap-accent);
      background: rgba(var(--cap-accent-rgb), 0.08);
    }

    .cap-narrative {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 460px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .cap-nar-stage {
      font-size: 0.75rem;
      color: var(--cap-muted);
      padding: 2px 0;
    }
    .cap-nar-thinking {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 8px 10px;
      border-left: 2px solid var(--cap-primary-line);
      background: var(--cap-surface-raised);
      border-radius: 0 var(--cap-radius-sm) var(--cap-radius-sm) 0;
    }
    .cap-nar-gate {
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cap-primary);
    }
    .cap-nar-text {
      margin: 0;
      font-size: 0.82rem;
      line-height: 1.45;
      color: var(--cap-text);
    }
    .cap-nar-tool {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-left: 12px;
      font-size: 0.76rem;
    }
    .cap-nar-tool-name {
      font-family: var(--cap-mono, monospace);
      color: var(--cap-muted);
      white-space: nowrap;
    }
    .cap-nar-tool-why { color: var(--cap-muted); }
    .cap-nar-tool--fail .cap-nar-tool-name { color: var(--cap-danger); }
    .cap-nar-finding {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 10px;
      font-size: 0.8rem;
      border-radius: var(--cap-radius-sm);
      background: rgba(220, 38, 38, 0.06);
    }
    .cap-nar-sev {
      font-size: 0.66rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--cap-danger);
      white-space: nowrap;
    }
    .cap-nar-finding[data-severity="low"] .cap-nar-sev,
    .cap-nar-finding[data-severity="note"] .cap-nar-sev { color: var(--cap-muted); }
    .cap-nar-finding[data-severity="low"],
    .cap-nar-finding[data-severity="note"] { background: var(--cap-surface-raised); }
    .cap-nar-gatedone {
      font-size: 0.72rem;
      color: var(--cap-muted);
      font-style: italic;
      padding-left: 12px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewControlPanelComponent implements OnDestroy {
  readonly store = inject(CapillaryStore);
  private readonly api = inject(ApiClientService);
  readonly starting = computed(() => this.api.inFlight() > 0 && this.store.status() !== "reviewing");
  readonly gates = TCSRTC_GATES;

  // Whole-second run clock — a useful "how long has this been going" readout,
  // not millisecond theater. Driven by the durable session's startedAt, so it
  // is correct even after a page refresh mid-run.
  readonly #now = signal(Date.now());
  readonly #clock = setInterval(() => this.#now.set(Date.now()), 1000);
  readonly runElapsedLabel = computed(() => {
    const now = this.#now();
    const session = this.store.reviewSessions()
      .find((candidate) => candidate.runId === this.store.activeSessionRunId());
    if (!session?.active) {
      return null;
    }
    const total = Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
  });

  ngOnDestroy(): void {
    clearInterval(this.#clock);
  }

  // Live phase readout — show the active gate + cycle while running, not "idle".
  readonly phaseLabel = computed(() => {
    const status = this.store.status();
    if (status === "reviewing") {
      const gate = this.store.reviewCurrentGate();
      const cycle = this.store.reviewCycle();
      return `Gate ${gate ?? "—"} · Cycle ${cycle || 1}`;
    }
    return this.statusLabel(status);
  });

  // Humanize raw status enums (PULL_REQUEST_SELECTED -> "PR selected").
  statusLabel(status: string): string {
    const map: Record<string, string> = {
      idle: "Idle",
      pull_request_selected: "PR selected",
      queued: "Queued",
      graphing: "Mapping",
      wetting: "Impact",
      reviewing: "Reviewing",
      completed: "Complete",
      failed: "Failed",
      cancelling: "Stopping…",
      cancelled: "Cancelled",
    };
    return map[status.toLowerCase()] ?? status.replace(/_/g, " ");
  }
  readonly reviewStatus = computed(() => this.store.reviewRun()?.status ?? this.store.status());
  readonly showFinalOutput = computed(() => this.store.status() === "completed" && Boolean(this.store.reviewReport()));
  readonly narrative = computed(() => this.store.reviewNarrative().slice(-48));
  readonly phase = computed<ReviewPhase>(() => {
    const status = this.store.status();
    if (status === "completed") {
      return "completed";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "cancelled") {
      return "cancelled";
    }
    return toReviewPhase(this.store.reviewRun()?.currentPhase);
  });
  readonly currentPhase = computed(() => this.store.reviewRun()?.currentPhase ?? "idle");
  readonly agentWorking = computed(() => {
    const status = this.store.status();
    return status === "reviewing" || status === "graphing" || status === "wetting";
  });

  beginReview(): void {
    void this.store.beginReview();
  }

  cancelReview(): void {
    void this.store.cancelReview();
  }

  onTraceToggle(event: Event): void {
    this.store.toggleReviewTrace((event.target as HTMLInputElement).checked);
  }

  onSuggestToggle(event: Event): void {
    this.store.toggleReviewSuggest((event.target as HTMLInputElement).checked);
  }

  postToPr(): void {
    void this.store.postReviewSummaryToPr();
  }

  // Console type badge per narrative event.
  badgeFor(entry: { kind: string; text?: string }): string {
    switch (entry.kind) {
      case "stage":
        return /torus|graph|mapped|dag/i.test(entry.text ?? "") ? "GRAPH" : "STAGE";
      case "thinking":
        return "THINK";
      case "tool":
        return "TOOL";
      case "finding":
        return "FIND";
      case "gate":
        return "GATE";
      default:
        return "•";
    }
  }

  readonly runningCount = computed(() =>
    this.store.reviewSessions().filter((session) => session.active).length
  );

  switchSession(runId: string): void {
    this.store.switchToSession(runId);
  }

  confirmNewSession(): void {
    void this.store.confirmNewSession();
  }

  dismissWarning(): void {
    this.store.dismissNewSessionWarning();
  }
}
