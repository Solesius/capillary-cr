// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { CapillaryStore } from "../state/capillary.store";

@Component({
  selector: "app-github-repository-picker",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>GitHub</span>
        @if (store.githubConnected()) {
          <span class="cap-status-pill cap-status-pill--ok">
            <span class="cap-status-dot"></span>ready
          </span>
        } @else {
          <span class="cap-status-pill cap-status-pill--idle">
            <span class="cap-status-dot"></span>not connected
          </span>
        }
      </header>

      <div class="cap-panel-body">

        @if (!store.githubConnected()) {
          <div class="cap-connect-block">
            <button class="cap-button cap-button-primary cap-button-full" (click)="connectOAuth()">
              Connect with GitHub
            </button>

            <div class="cap-divider-label">
              <span>or use a personal access token</span>
            </div>

            <input
              id="tokenInput"
              type="password"
              class="cap-input"
              autocomplete="off"
              placeholder="ghp_ ..."
              [value]="githubToken()"
              (input)="githubToken.set($any($event.target).value)" />
            <button
              class="cap-button cap-button-full"
              [disabled]="!githubToken().trim()"
              (click)="connectPat()">
              Connect PAT
            </button>
          </div>
        } @else {
          <div class="cap-field-group">
            <label class="cap-field-label" for="repoSearch">Repository</label>
            <input
              id="repoSearch"
              type="search"
              class="cap-input"
              autocomplete="off"
              placeholder="Search {{ store.repositories().length }} repositories…"
              [value]="repoQuery()"
              (input)="repoQuery.set($any($event.target).value)" />
            <select
              id="repoSelect"
              class="cap-select"
              [size]="listSize()"
              [value]="store.selectedRepositoryId() ?? ''"
              (change)="selectRepository($any($event.target).value)">
              <option value="" disabled>
                {{ store.repositories().length === 0 ? 'Loading repositories…' : filteredRepositories().length === 0 ? 'No repositories match' : 'Select a repository' }}
              </option>
              @for (repo of filteredRepositories(); track repo.id) {
                <option [value]="repo.id">{{ repo.fullName }}</option>
              }
            </select>
          </div>

          @if (store.selectedRepository()) {
            <div class="cap-repo-meta">
              <span class="cap-muted">{{ store.pullRequests().length }} {{ store.prStateFilter() }} pull request{{ store.pullRequests().length !== 1 ? 's' : '' }}</span>
              @if (store.selectedRepository()?.language) {
                <span class="cap-chip cap-chip--lang">{{ store.selectedRepository()?.language }}</span>
              }
            </div>
          }

          @if (store.lastError()) {
            <p class="cap-field-error">{{ store.lastError() }}</p>
          }
        }
      </div>
    </section>
  `,
  styles: [`
    .cap-connect-block {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .cap-button-full {
      width: 100%;
      justify-content: center;
    }
    .cap-divider-label {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--cap-muted);
      font-size: 0.75rem;
      margin: 4px 0;
    }
    .cap-divider-label::before,
    .cap-divider-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--cap-border);
    }
    .cap-field-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cap-field-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--cap-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .cap-field-error {
      font-size: 0.8rem;
      color: var(--cap-danger);
      margin: 6px 0 0;
    }
    .cap-repo-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 10px;
      font-size: 0.8rem;
    }
    .cap-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .cap-status-pill--ok {
      background: rgba(15, 118, 110, 0.12);
      color: var(--cap-ok);
    }
    .cap-status-pill--idle {
      background: var(--cap-border-soft);
      color: var(--cap-muted);
    }
    .cap-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .cap-chip--lang {
      font-size: 0.7rem;
      background: var(--cap-border-soft);
      color: var(--cap-muted);
      padding: 2px 7px;
      border-radius: 4px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitHubRepositoryPickerComponent {
  readonly store = inject(CapillaryStore);
  readonly githubToken = signal("");
  readonly repoQuery = signal("");
  readonly filteredRepositories = computed(() => {
    const query = this.repoQuery().trim().toLowerCase();
    const repos = this.store.repositories();
    if (!query) {
      return repos;
    }
    // Always keep the current selection visible so the <select> value stays valid.
    const selectedId = this.store.selectedRepositoryId();
    return repos.filter((repo) =>
      repo.fullName.toLowerCase().includes(query) || repo.id === selectedId
    );
  });
  // Expand into a scrollable listbox while filtering; stay a dropdown otherwise.
  readonly listSize = computed(() => {
    if (!this.repoQuery().trim()) {
      return 1;
    }
    return Math.max(2, Math.min(8, this.filteredRepositories().length + 1));
  });

  connectOAuth(): void {
    void this.store.connectWithGithubOAuth(window.location.origin, this.githubToken().trim() || undefined);
  }

  connectPat(): void {
    void this.store.connect(this.githubToken().trim() || undefined);
  }

  selectRepository(repositoryId: string): void {
    void this.store.selectRepository(repositoryId);
  }
}
