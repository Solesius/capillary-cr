// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { GitHubRepositoryPickerComponent } from "../github/github-repository-picker.component";
import { GraphTorusViewportComponent } from "../graph/graph-torus-viewport.component";
import { PullRequestCardGridComponent } from "../pr/pull-request-card-grid.component";
import { ReviewControlPanelComponent } from "../review/review-control-panel.component";
import { ApiClientService } from "../services/api-client.service";
import { CapillaryStore } from "../state/capillary.store";
import { RetvPlannerProviderKind } from "../models";
import { MarkdownPipe } from "./markdown.pipe";
import { FileExplorerComponent } from "../explorer/file-explorer.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    CommonModule,
    FileExplorerComponent,
    GitHubRepositoryPickerComponent,
    GraphTorusViewportComponent,
    PullRequestCardGridComponent,
    ReviewControlPanelComponent,
    MarkdownPipe,
  ],
  template: `
    <div class="cap-app">
      <div class="cap-netbar" [class.active]="networkBusy()" aria-hidden="true"><span></span></div>
      <header class="cap-appbar">
        <div class="cap-appbar-row">
          <section class="cap-appbar-left">
            <div class="cap-brand">
              <svg class="cap-brand-mark" viewBox="0 0 44 40" aria-hidden="true">
                <ellipse cx="22" cy="20" rx="17" ry="9.5" fill="none" stroke="rgb(45, 212, 191)" stroke-width="2.4" />
                <ellipse cx="22" cy="20" rx="7.5" ry="3.4" fill="none" stroke="rgb(45, 212, 191)" stroke-width="1.6" opacity="0.75" />
                <circle cx="34.5" cy="14.5" r="2.8" fill="#ffd400" />
                <circle cx="11" cy="26" r="1.8" fill="currentColor" opacity="0.55" />
              </svg>
              <div class="cap-brand-text">
                <span class="cap-brand-name">CAPILLARY</span>
                <span class="cap-brand-sub">agentic code review</span>
              </div>
            </div>
          </section>

          <section class="cap-appbar-right">
            <span class="cap-chip" [attr.data-state]="store.status()">{{ statusLabel(store.status()) }}</span>
            <button
              class="cap-icon-button cap-theme-toggle"
              type="button"
              [attr.aria-label]="theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
              [attr.aria-pressed]="theme() === 'dark'"
              (click)="toggleTheme()">
              @if (theme() === 'dark') {
                <span class="cap-theme-glyph" aria-hidden="true">☀</span>
              } @else {
                <span class="cap-theme-glyph" aria-hidden="true">☾</span>
              }
            </button>
            <button
              class="cap-icon-button cap-function-button"
              type="button"
              aria-label="Open function launcher"
              aria-haspopup="dialog"
              [attr.aria-expanded]="functionMenuOpen()"
              (click)="toggleFunctionMenu()">
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
              <span class="cap-launch-dot"></span>
            </button>
          </section>
        </div>

        <p class="cap-subtitle">A PR is not a patch — see what your change touches, then review it gate by gate.</p>
      </header>

      @if (functionMenuOpen()) {
        <button class="cap-menu-scrim" type="button" aria-label="Close function launcher" (click)="closeFunctionMenu()"></button>
        <section class="cap-function-launcher" aria-label="Function launcher">
          <header class="cap-launch-head">
            <span>Functions</span>
            <span class="cap-muted">Quick access</span>
          </header>
          <div class="cap-launch-grid">
            <button class="cap-launch-card" type="button" (click)="openPageFromFunctionMenu('run')">
              <strong>Run Board</strong>
              <span class="cap-muted">Overview, graph, findings</span>
            </button>
            <button class="cap-launch-card" type="button" (click)="openPageFromFunctionMenu('github')">
              <strong>GitHub</strong>
              <span class="cap-muted">Repositories and pull requests</span>
            </button>
            <button class="cap-launch-card" type="button" (click)="openPageFromFunctionMenu('agent')">
              <strong>Agent Lab</strong>
              <span class="cap-muted">CDP session control</span>
            </button>
            <button class="cap-launch-card" type="button" (click)="openPageFromFunctionMenu('setup')">
              <strong>Setup</strong>
              <span class="cap-muted">Planner provider configuration</span>
            </button>
          </div>
          <div class="cap-launch-actions">
            <button class="cap-button" type="button" (click)="refreshAgentSessionsFromMenu()">Refresh CDP Sessions</button>
            <button class="cap-button" type="button" (click)="loadSetupConfigFromMenu()">Reload Planner Config</button>
            <button
              class="cap-button"
              type="button"
              (click)="closeAgentBrowserFromMenu()"
              [disabled]="!store.activeCdpSession()">
              Close Active Browser Session
            </button>
          </div>
        </section>
      }

      @if (store.pendingNavigation(); as navUrl) {
        <button class="cap-menu-scrim" type="button" aria-label="Cancel navigation" (click)="store.cancelNavigation()"></button>
        <section class="cap-modal" role="dialog" aria-modal="true" aria-label="Confirm navigation">
          <header class="cap-modal-head">
            <span class="cap-kicker">Confirm navigation</span>
            <h2 class="cap-modal-title">Send the agent browser here?</h2>
          </header>
          <p class="cap-modal-url">{{ navUrl }}</p>
          @if (store.navigationIsOffOrigin(navUrl)) {
            <p class="cap-modal-warn">This leaves the current site origin. The agent's drift guard may pause after off-origin steps.</p>
          }
          <div class="cap-modal-actions">
            <button class="cap-button" type="button" (click)="store.cancelNavigation()">Cancel</button>
            <button class="cap-button cap-button-primary" type="button" (click)="store.confirmNavigation()">Go there</button>
          </div>
        </section>
      }

      <div class="cap-shell-body">
        <nav class="cap-page-tabs" aria-label="Workspace pages">
          <button class="cap-page-tab" type="button" [class.active]="activePage() === 'run'" (click)="setPage('run')">Run</button>
          <button class="cap-page-tab" type="button" [class.active]="activePage() === 'github'" (click)="setPage('github')">GitHub</button>
          <button class="cap-page-tab" type="button" [class.active]="activePage() === 'agent'" (click)="setPage('agent')">QA Agent</button>
          <button class="cap-page-tab" type="button" [class.active]="activePage() === 'setup'" (click)="setPage('setup')">Setup</button>
          <button
            class="cap-page-tab cap-page-tab--files"
            type="button"
            [class.active]="store.explorerOpen()"
            [disabled]="!store.selectedPullRequestId()"
            (click)="store.explorerOpen() ? store.closeExplorer() : store.openExplorer()">
            Files ⌥
          </button>
        </nav>

        <section class="cap-stats" aria-label="Review metrics">
          <article class="cap-stat">
            <p class="cap-stat-label">Repository</p>
            <p class="cap-stat-value">{{ store.selectedRepository()?.name ?? '—' }}</p>
          </article>
          <article class="cap-stat">
            <p class="cap-stat-label">Open PRs</p>
            <p class="cap-stat-value">{{ store.openPullRequestCount() }}</p>
          </article>
          <article class="cap-stat">
            <p class="cap-stat-label">Findings</p>
            <p class="cap-stat-value">{{ store.findingCount() }}</p>
          </article>
          <article class="cap-stat">
            <p class="cap-stat-label">Checklist Done</p>
            <p class="cap-stat-value">{{ store.checklistCompletion() }}%</p>
          </article>
        </section>

        @if (activePage() === 'run') {
          <section class="cap-page-content">

            @if (!store.githubConnected()) {
              <div class="cap-target-rail cap-target-rail--warn">
                <span>Connect GitHub to begin a review.</span>
                <button class="cap-button cap-button-ghost cap-button-sm" type="button" (click)="setPage('github')">Go to GitHub →</button>
              </div>
            } @else if (!store.selectedRepositoryId()) {
              <div class="cap-target-rail cap-target-rail--warn">
                <span>Select a repository and pull request.</span>
                <button class="cap-button cap-button-ghost cap-button-sm" type="button" (click)="setPage('github')">Go to GitHub →</button>
              </div>
            } @else if (!store.selectedPullRequestId()) {
              <div class="cap-target-rail cap-target-rail--warn">
                <span>{{ store.selectedRepository()?.fullName }} — select a pull request to review.</span>
                <button class="cap-button cap-button-ghost cap-button-sm" type="button" (click)="setPage('github')">Pick a PR →</button>
              </div>
            } @else {
              <div class="cap-target-rail cap-target-rail--ready">
                <span class="cap-target-rail__repo">{{ store.selectedRepository()?.fullName }}</span>
                <span class="cap-target-rail__sep">·</span>
                <span class="cap-target-rail__pr">{{ store.selectedPullRequest()?.title }}</span>
                <span class="cap-target-rail__num">#{{ store.selectedPullRequest()?.number }}</span>
              </div>
            }

            <section class="cap-panel">
              <app-review-control-panel />
            </section>

            @if (store.reviewGraph()) {
              <section class="cap-panel">
                <app-graph-torus-viewport />
              </section>
            }

            <section class="cap-panel">
              <header class="cap-panel-title">
                <span>Previous Reviews</span>
                <button class="cap-button cap-button-ghost" (click)="store.loadReviewRunHistory()">Refresh</button>
              </header>
              <div class="cap-panel-body cap-list cap-history-scroll">
                @if (store.reviewRunHistory().length === 0) {
                  <p class="cap-muted">No saved reviews yet.</p>
                }
                @for (run of store.reviewRunHistory(); track run.runId) {
                  <button
                    class="cap-history-row"
                    [class.active]="run.runId === store.selectedReviewRunId()"
                    (click)="store.openReviewFromHistory(run.runId)">
                    <span class="cap-history-verdict" [class.pass]="run.verdict === 'approve'">
                      {{ run.verdict }}
                    </span>
                    <span class="cap-history-goal">{{ run.title }}</span>
                    <span class="cap-history-meta">
                      {{ run.findingCount }} findings · {{ run.blockerCount }} blocker · {{ run.highCount }} high · {{ run.stopReason }}{{ run.traceEnabled ? ' · traced' : '' }}
                    </span>
                    <span class="cap-history-at">{{ run.finishedAt }}</span>
                  </button>
                }
              </div>
            </section>
          </section>
        }

        @if (activePage() === 'github') {
          <section class="cap-page-content">
            <div class="cap-two-up">
              <section class="cap-panel">
                <app-github-repository-picker />
              </section>
              <section class="cap-panel">
                <app-pull-request-card-grid />
              </section>
            </div>
          </section>
        }

        @if (activePage() === 'agent') {
          <section class="cap-page-content">
            <div class="cap-qa-grid">
              <section class="cap-panel cap-qa-mission">
                <header class="cap-panel-title">
                  <span>Functional QA</span>
                  <span class="cap-qa-head-metrics">
                    @if (store.cdpTokensTotal() > 0) {
                      <span class="cap-qa-tokens" title="Model tokens — input / output for this run">
                        in {{ store.cdpInputTokens() | number }} · out {{ store.cdpOutputTokens() | number }}
                      </span>
                    }
                    @if (qaElapsedLabel(); as elapsed) {
                      <span class="cap-qa-clock">run {{ elapsed }}</span>
                    }
                    <span class="cap-qa-state" [class.live]="store.agentStreaming() || store.cdpRoundRunning()">
                      {{ store.agentStreaming() ? 'streaming' : (store.cdpRoundRunning() ? 'running' : 'idle') }} · queue {{ store.cdpQueueDepth() }}
                    </span>
                  </span>
                </header>
                <div class="cap-panel-body">
                  <p class="cap-qa-kicker">Target</p>
                  <input
                    id="agentStartUrl"
                    class="cap-input"
                    placeholder="http://localhost:4200"
                    [value]="store.cdpStartUrl()"
                    (input)="store.cdpStartUrl.set($any($event.target).value)" />
                  <input
                    id="agentAllowedDomains"
                    class="cap-input cap-qa-gap"
                    placeholder="allowed domains — example.com, app.example.com · * roams"
                    [value]="store.cdpAllowedDomains()"
                    (input)="store.cdpAllowedDomains.set($any($event.target).value)" />
                  <p class="cap-muted cap-field-hint">
                    Drift scope: {{ store.cdpStartUrl() || 'localhost:4200' }}{{ store.cdpAllowedDomains().trim() ? ' · ' + store.cdpAllowedDomains().trim() : '' }}
                  </p>

                  <p class="cap-qa-kicker">Goal</p>
                  <textarea
                    id="agentGoal"
                    class="cap-input cap-textarea"
                    placeholder="validate login flow and verify dashboard widgets load"
                    [value]="agentGoalInput()"
                    (input)="agentGoalInput.set($any($event.target).value)"></textarea>

                  @if (store.cdpGoal(); as activeGoal) {
                    <div class="cap-qa-goal-live">
                      <div class="cap-qa-goal-live-head">
                        <span class="cap-qa-kicker" style="margin: 0;">Active goal</span>
                        <button
                          class="cap-button cap-button-ghost cap-button-sm"
                          type="button"
                          (click)="copyActiveGoal()">
                          {{ goalCopied() ? 'Copied ✓' : 'Copy' }}
                        </button>
                      </div>
                      <span class="cap-qa-goal-live-text">{{ activeGoal }}</span>
                    </div>
                  }

                  <label class="cap-qa-option">
                    <input
                      type="checkbox"
                      [checked]="store.cdpTraceEnabled()"
                      (change)="store.cdpTraceEnabled.set($any($event.target).checked)" />
                    <span class="cap-qa-option-name">Trace run</span>
                    <span class="cap-muted">per-step trace + screenshots, bundle export</span>
                  </label>


                  <div class="cap-row cap-qa-actions">
                    <button class="cap-button cap-button-primary" (click)="runLiveFunctionalRound()" [disabled]="store.agentStreaming()">Run Live ▶</button>
                    <button class="cap-button" (click)="beginFunctionalRound()" [disabled]="store.cdpRoundRunning()">Run batch</button>
                    <button class="cap-button" (click)="stopLiveRound()" [disabled]="!store.agentStreaming()">Stop</button>
                  </div>

                  @if (store.cdpRoundRunning() || store.agentStreaming()) {
                    <div class="cap-agent-loader active" [attr.data-phase]="store.agentRunPhase()">
                      <div class="cap-agent-loader-track"></div>
                      <div class="cap-agent-loader-sheen"></div>
                      <div class="cap-agent-loader-meta">
                        <strong>{{ store.agentRunPhaseLabel() }}</strong>
                        <span>
                          @if (store.cdpGoalProgress()) {
                            {{ store.cdpGoalProgress()!.completedMilestones }}/{{ store.cdpGoalProgress()!.totalMilestones }} milestones · {{ store.cdpGoalProgress()!.percent }}%
                          } @else {
                            waiting for first cycle telemetry
                          }
                        </span>
                      </div>
                    </div>
                  }

                  <div class="cap-qa-sessions">
                    <div class="cap-qa-sessions-head">
                      <span class="cap-qa-kicker">Sessions · {{ store.cdpSessions().length }}</span>
                      <span class="cap-qa-session-tools">
                        <button
                          class="cap-button cap-button-sm"
                          title="The co-engineer surface: focuses the open window, reopens if you closed it. Sign in by hand, then steer the run."
                          (click)="openHeadedBrowser()">Open Browser ▸</button>
                        <button class="cap-button cap-button-ghost cap-button-sm" (click)="launchAgentBrowser()">Headless</button>
                        <button class="cap-button cap-button-ghost cap-button-sm" (click)="refreshAgentSessions()">Refresh</button>
                        <button class="cap-button cap-button-ghost cap-button-sm" (click)="closeAgentBrowser()" [disabled]="!store.activeCdpSession()">Close</button>
                      </span>
                    </div>
                    @if (store.cdpSessions().length === 0) {
                      <p class="cap-muted cap-qa-empty">No browser yet — Launch one, or Run Live and it auto-starts.</p>
                    } @else {
                      <div class="cap-qa-session-strip">
                        @for (session of store.cdpSessions(); track session.sessionId) {
                          <button
                            type="button"
                            class="cap-qa-session-chip"
                            [class.current]="store.activeCdpSessionId() === session.sessionId"
                            [attr.title]="session.targetUrl"
                            (click)="selectSession(session.sessionId)">
                            <span class="cap-qa-session-dot"></span>{{ session.sessionId.slice(-6) }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                </div>
              </section>

              <section class="cap-panel cap-qa-stage">
                <header class="cap-panel-title cap-qa-stage-head">
                  <span class="cap-qa-stage-title">Live Browser</span>
                  <div class="cap-qa-address">
                    <input
                      id="agentNavUrl"
                      class="cap-input"
                      placeholder="https://example.com/path"
                      [value]="agentNavUrlInput()"
                      (input)="agentNavUrlInput.set($any($event.target).value)"
                      (keydown.enter)="requestNavigate()" />
                    <button class="cap-button cap-button-sm" (click)="requestNavigate()" [disabled]="!store.activeCdpSession()">Go</button>
                  </div>
                  <span class="cap-muted cap-qa-frame-tag">{{ store.agentStreaming() ? 'live' : 'last frame' }}</span>
                </header>
                <div class="cap-qa-frame">
                  @if (store.agentScreenshot()) {
                    <img class="cap-agent-frame" [src]="store.agentScreenshot()" alt="Live browser frame" />
                  } @else {
                    <div class="cap-qa-frame-empty">
                      <strong>The stage is dark.</strong>
                      <span>Point Target at your app, give it a Goal, hit Run Live — frames stream here.</span>
                    </div>
                  }
                </div>

                @if (store.cdpRoundRunning() || store.agentStreaming()) {
                  <div class="cap-qa-telemetry">
                    <article class="cap-planner-pane">
                      <div class="cap-planner-head">
                        <strong>Reasoning Live</strong>
                        <span>
                          @if (store.agentPlannerCycle() !== null) {
                            cycle {{ store.agentPlannerCycle() }}
                          } @else {
                            waiting
                          }
                        </span>
                      </div>
                      <p class="cap-planner-text">{{ store.agentPlannerLiveText() || 'planner tokens stream here as they are produced.' }}</p>
                    </article>
                    <article class="cap-planner-pane">
                      <div class="cap-planner-head">
                        <strong>Tool Picks</strong>
                        <span>{{ store.agentPlannerToolHistory().length }}</span>
                      </div>
                      <div class="cap-planner-tool-list">
                        @if (store.agentPlannerToolHistory().length === 0) {
                          <span class="cap-planner-empty">no tool picks yet</span>
                        }
                        @for (entry of store.agentPlannerToolHistory(); track entry.id) {
                          <span class="cap-tool-pill" [title]="entry.reason">#{{ entry.cycle }} · {{ entry.tool }}</span>
                        }
                      </div>
                    </article>
                  </div>
                }

                @if (store.activeCdpSession()) {
                  <div class="cap-qa-steer">
                    <span class="cap-qa-steer-label">steer</span>
                    <input
                      id="agentSteer"
                      class="cap-input"
                      placeholder="click .retry-button · type input[name=email] => test@capillary.dev"
                      [value]="agentInstructionInput()"
                      (input)="agentInstructionInput.set($any($event.target).value)"
                      (keydown.enter)="sendSteerInstruction()" />
                    <button class="cap-button cap-button-sm" (click)="sendSteerInstruction()">Send</button>
                  </div>
                }
              </section>
            </div>

            <section class="cap-panel">
              <header class="cap-panel-title">
                <span>Live Console</span>
                <span class="cap-muted">
                  {{ store.agentConsole().length }} lines
                  <button class="cap-button cap-button-mini" (click)="store.clearAgentConsole()">clear</button>
                </span>
              </header>
              <div class="cap-panel-body cap-agent-console" #agentConsoleBox>
                @if (store.agentConsole().length === 0) {
                  <p class="cap-muted">Planner trace streams here during a run.</p>
                }
                @for (line of store.agentConsole(); track line.id) {
                  <div class="cap-console-line" [attr.data-channel]="line.channel">
                    <span class="cap-console-time">{{ line.at }}</span>
                    <span class="cap-console-badge">{{ line.channel }}</span>
                    <pre class="cap-console-text">{{ line.text }}</pre>
                  </div>
                }
              </div>
            </section>

            <section class="cap-panel">
              <header class="cap-panel-title">
                <span>Test Report</span>
                <span class="cap-muted">{{ store.cdpSelectedRunId() || 'no run selected' }}</span>
              </header>
              <div class="cap-panel-body">
                @if (!store.cdpRunReport()) {
                  <p class="cap-muted">Functional report from the last run. Available with or without tracing.</p>
                }
                @if (store.cdpRunReport()) {
                  <div class="cap-row cap-report-actions">
                    <button class="cap-button" (click)="store.downloadSelectedReport()">Download report (.md)</button>
                    @if (store.cdpSelectedRunTraceEnabled()) {
                      <button class="cap-button cap-button-primary" (click)="store.exportSelectedRun()">Export bundle (.zip)</button>
                      <button class="cap-button cap-button-ghost" (click)="store.exportSelectedDriver('playwright')" title="Deterministic Playwright spec generated from this run">Driver script (.spec.ts)</button>
                      <button class="cap-button cap-button-ghost" (click)="store.exportSelectedDriver('runsheet')" title="Model-agnostic instructions for any coding agent to reproduce this run">Agent runsheet (.md)</button>
                    } @else {
                      <span class="cap-muted">run not traced — bundle export unavailable</span>
                    }
                  </div>
                  <div class="cap-md-report" [innerHTML]="store.cdpRunReport() | capMarkdown"></div>
                }
              </div>
            </section>

            <section class="cap-panel">
              <header class="cap-panel-title">
                <span>Previous Runs</span>
                <button class="cap-button cap-button-ghost" (click)="store.loadRetvRunHistory()">Refresh</button>
              </header>
              <div class="cap-panel-body cap-list">
                @if (store.cdpRunHistory().length === 0) {
                  <p class="cap-muted">No saved runs yet.</p>
                }
                @for (run of store.cdpRunHistory(); track run.runId) {
                  <button
                    class="cap-history-row"
                    [class.active]="run.runId === store.cdpSelectedRunId()"
                    (click)="store.openRunFromHistory(run.runId)">
                    <span class="cap-history-verdict" [class.pass]="run.functionalTestSucceeded">
                      {{ run.functionalTestSucceeded ? 'PASS' : 'FAIL' }}
                    </span>
                    <span class="cap-history-goal">{{ run.goal }}</span>
                    <span class="cap-history-meta">
                      {{ run.milestonesCompleted }}/{{ run.milestonesTotal }} · {{ run.percent }}% · {{ run.stopReason }}{{ run.traceEnabled ? ' · traced' : '' }}
                    </span>
                    <span class="cap-history-at">{{ run.finishedAt }}</span>
                  </button>
                }
              </div>
            </section>
          </section>
        }

        @if (activePage() === 'setup') {
          <section class="cap-page-content">
            <div class="cap-two-up">
              <section class="cap-panel">
                <header class="cap-panel-title">
                  <span>RetV Planner</span>
                  <span class="cap-muted">Provider Config</span>
                </header>
                <div class="cap-panel-body cap-list cap-setup-form">
                  <p class="cap-muted">Choose a planner provider for RetV, then set model and endpoint.</p>

                  <label class="cap-muted" for="retvProviderKind">Provider</label>
                  <select
                    id="retvProviderKind"
                    class="cap-select"
                    [value]="setupProviderKindInput()"
                    (change)="onSetupProviderKindChanged($any($event.target).value)">
                    @for (option of setupProviderOptions; track option.value) {
                      <option [value]="option.value">{{ option.label }}</option>
                    }
                  </select>

                  <div class="cap-list">
                    <label class="cap-muted" for="retvModel">Model</label>
                    <input
                      id="retvModel"
                      class="cap-input"
                      list="retvModelChoices"
                      autocomplete="off"
                      [value]="setupModelInput()"
                      (input)="setupModelInput.set($any($event.target).value)"
                      placeholder="type any model id" />
                    <datalist id="retvModelChoices">
                      @for (m of setupModelChoices(); track m) {
                        <option [value]="m"></option>
                      }
                    </datalist>
                    <p class="cap-muted">Type any model id, or pick a suggestion. The endpoint stays pinned unless local.</p>
                  </div>

                  <p class="cap-muted">
                    @if (setupProviderNeedsApiKey()) {
                      Credentials are loaded from the API server environment for this provider (for example OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or CAPILLARY_LLM_API_KEY). No API key is entered here.
                    } @else {
                      This provider uses local CLI or GitHub OAuth authentication on the server side, so no API key is entered here.
                    }
                  </p>

                  <label class="cap-muted" for="retvEndpoint">Endpoint / Base URL</label>
                  <input
                    id="retvEndpoint"
                    class="cap-input"
                    [value]="setupEndpointInput()"
                    [readonly]="!setupAllowsEndpointOverride()"
                    (input)="setupEndpointInput.set($any($event.target).value)"
                    placeholder="http://localhost:1234/v1" />
                  @if (!setupAllowsEndpointOverride()) {
                    <p class="cap-muted">Model and endpoint are pinned to this provider's documented defaults on the server; only the local (OpenAI-compatible) provider accepts a custom endpoint.</p>
                  }

                  <div class="cap-row cap-setup-actions">
                    <button class="cap-button cap-button-primary" (click)="saveRetvPlannerConfig()">Save Planner Config</button>
                    <button class="cap-button" (click)="authenticateCopilotInBrowser()">Authenticate Copilot (Browser)</button>
                    <button class="cap-button" (click)="loadSetupConfig()">Reload</button>
                  </div>

                  @if (store.retvPlannerConfig()) {
                    <div class="cap-setup-meta">
                      <div class="cap-event-line">active provider: {{ store.retvPlannerConfig()!.providerKind }}</div>
                      <div class="cap-event-line">active model: {{ store.retvPlannerConfig()!.model }}</div>
                      <div class="cap-event-line">active endpoint: {{ store.retvPlannerConfig()!.baseUrl }}</div>
                      <div class="cap-event-line">auth: {{ setupProviderNeedsApiKey() ? 'server env vars' : 'CLI / OAuth' }}</div>
                    </div>
                  }
                </div>
              </section>
              <section class="cap-panel">
                <header class="cap-panel-title">
                  <span>Runtime Context</span>
                  <span class="cap-muted">Health + Scope</span>
                </header>
                <div class="cap-panel-body cap-list">
                  <div class="cap-event-line">API expected: localhost:8080</div>
                  <div class="cap-event-line">Web expected: localhost:4200</div>
                  <div class="cap-event-line">CDP expected: localhost:9222</div>
                  <div class="cap-event-line">Tip: use openai_compatible + local endpoint for local model servers.</div>
                  <div class="cap-event-line">github auth: {{ store.githubConnected() ? 'connected' : 'not connected' }}</div>
                  <div class="cap-event-line">status: {{ store.status() }}</div>
                  <div class="cap-event-line">repository: {{ store.selectedRepository()?.fullName ?? 'none' }}</div>
                  <div class="cap-event-line">pull request: {{ store.selectedPullRequest()?.title ?? 'none' }}</div>
                  <div class="cap-event-line">run id: {{ store.reviewRun()?.id ?? 'none' }}</div>
                </div>
              </section>
            </div>

            <section class="cap-panel" style="margin-top: 14px;">
              <header class="cap-panel-title">
                <span>Team Channels</span>
                <span class="cap-muted">Publish finished runs to Slack or Teams</span>
              </header>
              <div class="cap-panel-body cap-list cap-setup-form">
                <p class="cap-muted">
                  A connection is a channel: create an incoming webhook on the channel
                  (Slack: app directory → Incoming Webhooks; Teams: channel → Workflows →
                  "Post to a channel when a webhook request is received"), paste its URL here.
                  Finished reviews and functional runs post a card with the verdict, counts,
                  token totals and a link back to this instance. URLs must live on the
                  platform's webhook hosts (hooks.slack.com; *.webhook.office.com or
                  *.logic.azure.com for Teams) — self-hosted relays are allowed via
                  CAPILLARY_WEBHOOK_HOST_ALLOWLIST on the server.
                </p>
                @if (!store.teamPublicUrlConfigured()) {
                  <p class="cap-muted">
                    ⚠ CAPILLARY_PUBLIC_URL is not set — cards will publish without an
                    "Open in Capillary" link. Set it to this instance's reachable URL to
                    enable deep links.
                  </p>
                }

                <div class="cap-row" style="gap: 8px; flex-wrap: wrap; align-items: flex-end;">
                  <div class="cap-list" style="min-width: 110px;">
                    <label class="cap-muted" for="teamApp">App</label>
                    <select id="teamApp" class="cap-select" [value]="teamAppInput()"
                      (change)="teamAppInput.set($any($event.target).value)">
                      <option value="slack">Slack</option>
                      <option value="teams">Teams</option>
                    </select>
                  </div>
                  <div class="cap-list" style="min-width: 150px;">
                    <label class="cap-muted" for="teamLabel">Channel label</label>
                    <input id="teamLabel" class="cap-input" placeholder="#code-reviews"
                      [value]="teamLabelInput()"
                      (input)="teamLabelInput.set($any($event.target).value)" />
                  </div>
                  <div class="cap-list" style="flex: 1; min-width: 260px;">
                    <label class="cap-muted" for="teamWebhook">Incoming webhook URL</label>
                    <input id="teamWebhook" class="cap-input" type="password"
                      autocomplete="off" placeholder="https://hooks.slack.com/services/…"
                      [value]="teamWebhookInput()"
                      (input)="teamWebhookInput.set($any($event.target).value)" />
                  </div>
                  <button class="cap-button cap-button-primary" type="button"
                    [disabled]="store.teamConnectionBusy() || !teamWebhookInput().trim()"
                    (click)="addTeamChannel()">
                    {{ store.teamConnectionBusy() ? 'Adding…' : 'Add channel' }}
                  </button>
                </div>
                @if (store.teamConnectionError()) {
                  <p class="cap-muted">⚠ {{ store.teamConnectionError() }}</p>
                }

                @for (connection of store.teamConnections(); track connection.id) {
                  <div class="cap-card" style="margin-top: 8px;">
                    <div class="cap-row" style="gap: 10px; flex-wrap: wrap; align-items: center;">
                      <strong>{{ connection.label }}</strong>
                      <span class="cap-muted">{{ connection.app }} · {{ connection.webhookUrlMasked }}</span>
                      <span style="flex: 1;"></span>
                      <button class="cap-button cap-button-sm" type="button"
                        [disabled]="store.teamTestState()[connection.id] === 'testing'"
                        (click)="store.testTeamConnection(connection.id)">
                        {{ store.teamTestState()[connection.id] === 'testing' ? 'Testing…'
                          : store.teamTestState()[connection.id] === 'ok' ? 'Test ✓'
                          : store.teamTestState()[connection.id] === 'failed' ? 'Test ✗ — retry'
                          : 'Test' }}
                      </button>
                      <button class="cap-button cap-button-ghost cap-button-sm" type="button"
                        (click)="store.removeTeamConnection(connection.id)">
                        Remove
                      </button>
                    </div>
                    <div class="cap-row" style="gap: 14px; flex-wrap: wrap; margin-top: 8px;">
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.enabled"
                          (change)="store.patchTeamConnection(connection.id, { enabled: $any($event.target).checked })" />
                        <span class="cap-option-name">Enabled</span>
                      </label>
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.events.reviewCompleted"
                          (change)="store.patchTeamConnection(connection.id, { events: { reviewCompleted: $any($event.target).checked } })" />
                        <span class="cap-option-name">Reviews</span>
                      </label>
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.events.retvCompleted"
                          (change)="store.patchTeamConnection(connection.id, { events: { retvCompleted: $any($event.target).checked } })" />
                        <span class="cap-option-name">Functional runs</span>
                      </label>
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.events.reviewCancelled"
                          (change)="store.patchTeamConnection(connection.id, { events: { reviewCancelled: $any($event.target).checked } })" />
                        <span class="cap-option-name">Stopped runs</span>
                      </label>
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.events.findingPosted"
                          (change)="store.patchTeamConnection(connection.id, { events: { findingPosted: $any($event.target).checked } })" />
                        <span class="cap-option-name">Posted findings</span>
                      </label>
                      <label class="cap-option-row">
                        <input type="checkbox" [checked]="connection.detail === 'findings'"
                          (change)="store.patchTeamConnection(connection.id, { detail: $any($event.target).checked ? 'findings' : 'summary' })" />
                        <span class="cap-option-name">Include finding titles</span>
                        <span class="cap-option-hint">off = verdict, counts and link only</span>
                      </label>
                    </div>
                    @if (connection.lastError) {
                      <p class="cap-muted" style="margin-top: 6px;">⚠ last delivery: {{ connection.lastError }}</p>
                    } @else if (connection.lastPostedAt) {
                      <p class="cap-muted" style="margin-top: 6px;">last posted {{ connection.lastPostedAt }}</p>
                    }
                  </div>
                }
              </div>
            </section>
          </section>
        }
      </div>

      @if (store.lastError()) {
        <div class="cap-error">
          {{ store.lastError() }}
        </div>
      }

      <app-file-explorer />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CapillaryShellComponent {
  // Whole-second run clock for the QA agent — same idiom as the review timer.
  readonly #qaNow = signal(Date.now());
  readonly #qaClock = setInterval(() => this.#qaNow.set(Date.now()), 1000);
  readonly qaElapsedLabel = computed(() => {
    const now = this.#qaNow();
    const startedAt = this.store.cdpRunStartedAt();
    const live = this.store.agentStreaming() || this.store.cdpRoundRunning();
    if (!startedAt || !live) {
      return null;
    }
    const total = Math.max(0, Math.floor((now - startedAt) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  });

  readonly store = inject(CapillaryStore);
  private readonly api = inject(ApiClientService);
  readonly networkBusy = computed(() => this.api.inFlight() > 0);

  statusLabel(status: string): string {
    const map: Record<string, string> = {
      idle: "Idle",
      pull_request_selected: "PR selected",
      repository_selected: "Repo selected",
      queued: "Queued",
      graphing: "Mapping",
      wetting: "Impact",
      reviewing: "Reviewing",
      completed: "Complete",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return map[status.toLowerCase()] ?? status.replace(/_/g, " ").toLowerCase();
  }
  private readonly agentConsoleBox = viewChild<ElementRef<HTMLElement>>("agentConsoleBox");
  readonly activePage = signal<"run" | "github" | "setup" | "agent">("run");
  readonly theme = signal<"light" | "dark">(this.readStoredTheme());
  readonly functionMenuOpen = signal(false);
  readonly agentGoalInput = signal("");
  readonly agentInstructionInput = signal("");
  readonly agentNavUrlInput = signal("");
  readonly setupProviderKindInput = signal<RetvPlannerProviderKind>("codex_app_server");
  readonly setupModelInput = signal("gpt-5.4-mini");
  readonly setupEndpointInput = signal("stdio://codex-app-server");
  readonly setupProviderOptions: Array<{ value: RetvPlannerProviderKind; label: string }> = [
    { value: "codex_app_server", label: "Codex CLI — stdio, OAuth (recommended, no API key)" },
    { value: "claude_code", label: "Claude Code — stdio, OAuth (recommended, no API key)" },
    { value: "github_copilot", label: "GitHub Models / Copilot (uses your GitHub OAuth)" },
    { value: "openrouter", label: "OpenRouter (API key)" },
    { value: "anthropic", label: "Anthropic (API key)" },
    { value: "gemini", label: "Gemini (API key)" },
    { value: "ihhi_bedrock", label: "Bedrock (API key)" },
    { value: "openai_compatible", label: "OpenAI-compatible / local (API key)" },
  ];
  readonly setupProviderDefaults: Record<
    RetvPlannerProviderKind,
    { model: string; baseUrl: string }
  > = {
    github_copilot: { model: "openai/gpt-4.1", baseUrl: "https://models.github.ai" },
    openrouter: { model: "anthropic/claude-sonnet-4", baseUrl: "https://openrouter.ai/api/v1" },
    anthropic: { model: "claude-sonnet-4-20250514", baseUrl: "https://api.anthropic.com/v1" },
    gemini: {
      model: "gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    ihhi_bedrock: {
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    },
    codex_app_server: { model: "gpt-5.4-mini", baseUrl: "stdio://codex-app-server" },
    claude_code: { model: "sonnet", baseUrl: "stdio://claude-code" },
    openai_compatible: { model: "local-model", baseUrl: "http://localhost:1234/v1" },
  };

  // Team channel add-form inputs (Setup page).
  readonly teamAppInput = signal<"slack" | "teams">("slack");
  readonly teamLabelInput = signal("");
  readonly teamWebhookInput = signal("");

  async addTeamChannel(): Promise<void> {
    const ok = await this.store.addTeamConnection({
      app: this.teamAppInput(),
      label: this.teamLabelInput().trim(),
      webhookUrl: this.teamWebhookInput().trim(),
    });
    if (ok) {
      this.teamLabelInput.set("");
      this.teamWebhookInput.set("");
    }
  }

  constructor() {
    this.applyTheme(this.theme());
    void this.store.loadRetvRunHistory();
    void this.store.loadReviewRunHistory();
    void this.store.loadTeamConnections();
    // Channel-card deep links land on a URL param; route to the right page
    // once the store resolves what the link points at.
    effect(() => {
      const page = this.store.deepLinkPage();
      if (page) {
        this.setPage(page);
        this.store.deepLinkPage.set(null);
      }
    });
    effect(() => {
      // Track console length so the effect re-runs as lines stream in.
      this.store.agentConsole().length;
      const box = this.agentConsoleBox()?.nativeElement;
      if (box) {
        queueMicrotask(() => {
          box.scrollTop = box.scrollHeight;
        });
      }
    });
  }

  toggleTheme(): void {
    const next = this.theme() === "dark" ? "light" : "dark";
    this.theme.set(next);
    this.applyTheme(next);
    try {
      localStorage.setItem("cap-theme", next);
    } catch {
      // Storage may be unavailable (private mode); theme still applies for the session.
    }
  }

  private readStoredTheme(): "light" | "dark" {
    try {
      return localStorage.getItem("cap-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  private applyTheme(theme: "light" | "dark"): void {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
  }

  toggleFunctionMenu(): void {
    const nextOpen = !this.functionMenuOpen();
    this.functionMenuOpen.set(nextOpen);
  }

  closeFunctionMenu(): void {
    this.functionMenuOpen.set(false);
  }

  openPageFromFunctionMenu(page: "run" | "github" | "setup" | "agent"): void {
    this.setPage(page);
    this.closeFunctionMenu();
  }

  async refreshAgentSessionsFromMenu(): Promise<void> {
    await this.refreshAgentSessions();
    this.closeFunctionMenu();
  }

  async loadSetupConfigFromMenu(): Promise<void> {
    await this.loadSetupConfig();
    this.closeFunctionMenu();
  }

  async closeAgentBrowserFromMenu(): Promise<void> {
    await this.closeAgentBrowser();
    this.closeFunctionMenu();
  }

  setPage(page: "run" | "github" | "setup" | "agent"): void {
    this.activePage.set(page);
    this.functionMenuOpen.set(false);
    if (page === "setup") {
      void this.loadSetupConfig();
    }
  }

  onSetupProviderKindChanged(providerKind: RetvPlannerProviderKind): void {
    this.setupProviderKindInput.set(providerKind);
    const defaults = this.setupProviderDefaults[providerKind];
    this.setupModelInput.set(defaults.model);
    this.setupEndpointInput.set(defaults.baseUrl);
  }

  // Known-good model ids per provider, so Codex/Claude offer a picker instead
  // of a locked field. A typed value not in the list still saves (custom).
  private readonly setupModelChoicesByKind: Partial<Record<RetvPlannerProviderKind, string[]>> = {
    codex_app_server: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-codex", "o4-mini"],
    claude_code: ["sonnet", "opus", "haiku"],
    anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    github_copilot: ["openai/gpt-4.1", "openai/gpt-4o", "anthropic/claude-sonnet-4"],
    gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  };

  setupModelChoices(): string[] {
    return this.setupModelChoicesByKind[this.setupProviderKindInput()] ?? [];
  }

  /**
   * Keyless providers (stdio Codex/Claude, Copilot OAuth) authenticate through
   * the local CLI / GitHub login, so no API-key field is shown for them.
   */
  setupProviderNeedsApiKey(): boolean {
    const kind = this.setupProviderKindInput();
    return kind !== "codex_app_server" && kind !== "claude_code" && kind !== "github_copilot";
  }

  /**
   * Only the local OpenAI-compatible provider may point at a custom endpoint;
   * every documented cloud/CLI provider is pinned to its server-side defaults,
   * so its model and endpoint fields are shown read-only.
   */
  setupAllowsEndpointOverride(): boolean {
    return this.setupProviderKindInput() === "openai_compatible";
  }

  async refreshAgentSessions(): Promise<void> {
    await this.store.refreshCdpSessions();
  }

  async openHeadedBrowser(): Promise<void> {
    await this.store.openHeadedBrowser(this.store.cdpStartUrl() || undefined);
  }

  async launchAgentBrowser(): Promise<void> {
    const startUrl = this.store.cdpStartUrl().trim() || "about:blank";
    this.store.cdpStartUrl.set(startUrl);
    await this.store.launchAgentBrowser(startUrl);
  }

  async closeAgentBrowser(): Promise<void> {
    await this.store.closeAgentBrowser();
  }

  beginFunctionalRound(): void {
    const goal = this.agentGoalInput().trim();
    if (!goal) {
      return;
    }
    this.store.beginAgentFunctionalRound(goal);
    this.agentGoalInput.set("");
  }

  runLiveFunctionalRound(): void {
    const goal = this.agentGoalInput().trim();
    if (!goal) {
      return;
    }
    this.store.streamAgentFunctionalRound(goal);
    this.agentGoalInput.set("");
  }

  readonly goalCopied = signal(false);
  copyActiveGoal(): void {
    const goal = this.store.cdpGoal();
    if (!goal) {
      return;
    }
    void navigator.clipboard?.writeText(goal).then(() => {
      this.goalCopied.set(true);
      setTimeout(() => this.goalCopied.set(false), 1600);
    }).catch(() => {
      // Clipboard may be unavailable (permissions/http); selection still works.
    });
  }

  stopLiveRound(): void {
    void this.store.cancelAgentRun();
  }

  requestNavigate(): void {
    const url = this.agentNavUrlInput().trim();
    if (!url) {
      return;
    }
    this.store.requestNavigation(url);
  }

  sendSteerInstruction(): void {
    const instruction = this.agentInstructionInput().trim();
    if (!instruction) {
      return;
    }
    this.store.steerAgentRound(instruction);
    this.agentInstructionInput.set("");
  }

  selectSession(sessionId: string): void {
    this.store.setActiveCdpSession(sessionId);
  }

  async loadSetupConfig(): Promise<void> {
    await this.store.refreshRetvPlannerConfig();
    const config = this.store.retvPlannerConfig();
    if (!config) {
      return;
    }

    this.setupProviderKindInput.set(config.providerKind);
    this.setupModelInput.set(config.model);
    this.setupEndpointInput.set(config.baseUrl);
  }

  async saveRetvPlannerConfig(): Promise<void> {
    const providerKind = this.setupProviderKindInput();
    const allowsOverride = providerKind === "openai_compatible";
    await this.store.saveRetvPlannerConfig({
      providerKind,
      // Model is a free refinement; the endpoint is only honored for the local
      // provider, so it is sent solely in that case.
      model: this.setupModelInput().trim() || undefined,
      baseUrl: allowsOverride ? this.setupEndpointInput().trim() || undefined : undefined,
    });

    await this.loadSetupConfig();
  }

  async authenticateCopilotInBrowser(): Promise<void> {
    await this.store.connectWithGithubOAuth(window.location.origin);
    await this.loadSetupConfig();
  }
}
