// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { CapillaryStore } from "../state/capillary.store";

@Component({
  selector: "app-review-findings-panel",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>Findings</span>
        <span class="cap-muted">{{ filteredFindings().length }} / {{ store.findings().length }}</span>
      </header>

      <div class="cap-panel-body cap-finding-controls">
        <label class="cap-muted" for="findingSeverity">Severity</label>
        <select
          id="findingSeverity"
          class="cap-select"
          [value]="severityFilter()"
          (change)="severityFilter.set($any($event.target).value)">
          <option value="all">All</option>
          <option value="blocker">Blocker</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="note">Note</option>
        </select>

        <label class="cap-muted" for="findingSort">Sort</label>
        <select
          id="findingSort"
          class="cap-select"
          [value]="sortMode()"
          (change)="sortMode.set($any($event.target).value)">
          <option value="severity">Severity</option>
          <option value="confidence">Confidence</option>
        </select>
      </div>

      @if (filteredFindings().length === 0) {
        <div class="cap-panel-body">
          <p class="cap-muted">No findings for this filter yet.</p>
        </div>
      }

      <div class="cap-panel-body cap-list cap-findings">
        @for (finding of filteredFindings(); track finding.id) {
          <article class="cap-card finding-reveal">
            <div class="cap-row">
              <h3>{{ finding.title }}</h3>
              <span class="cap-pill" [class.high]="finding.severity === 'high' || finding.severity === 'blocker'" [class.medium]="finding.severity === 'medium'" [class.low]="finding.severity === 'low' || finding.severity === 'note'">{{ finding.severity }}</span>
            </div>
            <p class="cap-muted" style="margin-top: 7px;">{{ finding.filePath }}:{{ finding.line ?? 'n/a' }}</p>
            <p style="margin-top: 8px;">{{ finding.finding }}</p>
            <p class="cap-muted" style="margin-top: 8px;">Gate {{ finding.passName }} // Confidence {{ finding.confidence }}</p>
            @if (finding.evidence?.length) {
              <p class="cap-muted" style="margin-top: 8px;">Evidence: {{ finding.evidence[0] }}</p>
            }
            @if (finding.line) {
              <div class="cap-finding-actions">
                @if (store.commentState()[finding.id] === 'posted') {
                  <a class="cap-button cap-button-ghost cap-button-sm" [href]="store.commentUrl()[finding.id]" target="_blank" rel="noopener">Commented ✓ — view on GitHub</a>
                } @else {
                  <button
                    class="cap-button cap-button-sm"
                    type="button"
                    [class.busy]="store.commentState()[finding.id] === 'posting'"
                    [disabled]="store.commentState()[finding.id] === 'posting'"
                    (click)="postComment(finding.id)">
                    {{ store.commentState()[finding.id] === 'failed' ? 'Retry — post inline comment' : 'Post inline comment' }}
                  </button>
                }
              </div>
            }
            @if (finding.suggestion; as sug) {
              <div class="cap-suggestion">
                <div class="cap-suggestion-head">
                  <span class="cap-suggestion-tag">Suggested change</span>
                  <span class="cap-muted">{{ finding.filePath }}:{{ sug.startLine }}{{ sug.endLine > sug.startLine ? '–' + sug.endLine : '' }}</span>
                </div>
                <pre class="cap-suggestion-code"><code>{{ sug.code }}</code></pre>
                <div class="cap-suggestion-actions">
                  @if (store.suggestionState()[finding.id] === 'posted') {
                    <a class="cap-button cap-button-ghost cap-button-sm" [href]="store.suggestionUrl()[finding.id]" target="_blank" rel="noopener">Posted ✓ — view on GitHub</a>
                  } @else {
                    <button
                      class="cap-button cap-button-sm"
                      type="button"
                      [class.busy]="store.suggestionState()[finding.id] === 'posting'"
                      [disabled]="store.suggestionState()[finding.id] === 'posting'"
                      (click)="postSuggestion(finding.id)">
                      {{ store.suggestionState()[finding.id] === 'failed' ? 'Retry — post suggestion' : 'Post suggested change to PR' }}
                    </button>
                  }
                </div>
              </div>
            }
          </article>
        }
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewFindingsPanelComponent {
  readonly store = inject(CapillaryStore);
  readonly severityFilter = signal<"all" | "blocker" | "high" | "medium" | "low" | "note">("all");
  readonly sortMode = signal<"severity" | "confidence">("severity");

  postSuggestion(findingId: string): void {
    void this.store.postFindingSuggestion(findingId);
  }

  postComment(findingId: string): void {
    void this.store.postFindingComment(findingId);
  }

  readonly filteredFindings = computed(() => {
    const filter = this.severityFilter();
    const mode = this.sortMode();
    const severityOrder = new Map([
      ["blocker", 0],
      ["high", 1],
      ["medium", 2],
      ["low", 3],
      ["note", 4],
    ]);

    const filtered = this.store.findings().filter((finding) => filter === "all" || finding.severity === filter);
    return filtered
      .slice()
      .sort((left, right) => {
        if (mode === "confidence") {
          return right.confidence - left.confidence;
        }

        const leftRank = severityOrder.get(left.severity) ?? 99;
        const rightRank = severityOrder.get(right.severity) ?? 99;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.confidence - left.confidence;
      });
  });
}
