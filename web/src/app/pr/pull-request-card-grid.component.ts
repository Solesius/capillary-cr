// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { CapillaryStore } from "../state/capillary.store";

@Component({
  selector: "app-pull-request-card-grid",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>Pull Requests</span>
        <div class="cap-row" style="gap: 10px; align-items: center;">
          @if (store.selectedRepositoryId()) {
            <span class="cap-muted" style="font-size: 0.8rem;">{{ store.pullRequests().length }} {{ store.prStateFilter() }}</span>
            <select
              class="cap-select cap-select--inline"
              [value]="store.prStateFilter()"
              (change)="changeFilter($any($event.target).value)">
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          }
        </div>
      </header>

      <div class="cap-panel-body cap-list">
        @if (!store.selectedRepositoryId()) {
          <p class="cap-muted cap-empty-hint">Select a repository first.</p>
        } @else if (store.pullRequests().length === 0) {
          <p class="cap-muted cap-empty-hint">No {{ store.prStateFilter() }} pull requests.</p>
        } @else {
          @for (pr of store.pullRequests(); track pr.id) {
            <button
              class="cap-pr-card"
              [class.active]="store.selectedPullRequestId() === pr.id"
              (click)="selectPullRequest(pr.id)">
              <div class="cap-pr-card__head">
                <span class="cap-pr-card__title">{{ pr.title }}</span>
                <span class="cap-pr-card__number">#{{ pr.number }}</span>
              </div>
              <p class="cap-pr-card__meta">
                {{ pr.author }}&thinsp;→&thinsp;{{ pr.targetBranch }}
              </p>
              <div class="cap-pr-card__foot">
                <span class="cap-pr-card__diff">
                  {{ pr.changedFileCount }} file{{ pr.changedFileCount !== 1 ? 's' : '' }}
                  &nbsp;<span class="cap-diff-add">+{{ pr.additions }}</span>
                  &nbsp;<span class="cap-diff-del">−{{ pr.deletions }}</span>
                </span>
                @if (pr.riskHint && pr.riskHint !== 'unknown') {
                  <span class="cap-risk-badge cap-risk-badge--{{ pr.riskHint }}">{{ pr.riskHint }}</span>
                }
              </div>
            </button>
          }
        }
      </div>
    </section>
  `,
  styles: [`
    .cap-empty-hint { padding: 8px 0; }

    .cap-select--inline {
      width: auto;
      padding: 4px 8px;
      font-size: 0.78rem;
    }

    .cap-pr-card {
      display: flex;
      flex-direction: column;
      gap: 5px;
      width: 100%;
      text-align: left;
      padding: 12px 14px;
      border: 1px solid var(--cap-border);
      border-radius: var(--cap-radius-sm);
      background: var(--cap-surface-raised);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .cap-pr-card:hover {
      border-color: var(--cap-primary-line);
      background: var(--cap-surface-container);
    }
    .cap-pr-card.active {
      border-color: var(--cap-accent);
      background: rgba(var(--cap-accent-rgb), 0.06);
    }
    .cap-pr-card__head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }
    .cap-pr-card__title {
      font-weight: 600;
      font-size: 0.88rem;
      color: var(--cap-text);
      line-height: 1.3;
    }
    .cap-pr-card__number {
      font-size: 0.75rem;
      color: var(--cap-muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .cap-pr-card__meta {
      font-size: 0.78rem;
      color: var(--cap-muted);
      margin: 0;
    }
    .cap-pr-card__foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2px;
    }
    .cap-pr-card__diff {
      font-size: 0.75rem;
      color: var(--cap-muted);
      font-variant-numeric: tabular-nums;
    }
    .cap-diff-add { color: var(--cap-ok); }
    .cap-diff-del { color: var(--cap-danger); }

    .cap-risk-badge {
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      padding: 2px 7px;
      border-radius: 4px;
    }
    .cap-risk-badge--low      { background: rgba(15, 118, 110, 0.12); color: var(--cap-ok); }
    .cap-risk-badge--medium   { background: rgba(249, 115, 22, 0.14); color: var(--cap-accent); }
    .cap-risk-badge--high     { background: rgba(220, 38, 38, 0.12);  color: var(--cap-danger); }
    .cap-risk-badge--critical { background: var(--cap-danger); color: #fff; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PullRequestCardGridComponent {
  readonly store = inject(CapillaryStore);

  selectPullRequest(pullRequestId: string): void {
    this.store.selectPullRequest(pullRequestId);
  }

  changeFilter(value: string): void {
    if (value !== "open" && value !== "closed") return;
    void this.store.setPullRequestFilter(value);
  }
}
