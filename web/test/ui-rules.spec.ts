import { expect } from "chai";
import {
  areCardsDisabled,
  computeReviewStages,
  isBeginEnabled,
  seedPostedState,
  shouldShowCleanState,
  shouldShowGraphSummary,
  watchersLabel,
  windowRepositories,
} from "../src/app/state/rules";
import { REVIEW_PHASES, toReviewPhase } from "../src/app/models";

describe("Capillary frontend rules", () => {
  it("should_enable_begin_review_when_pull_request_is_selected", () => {
    expect(isBeginEnabled(true)).to.equal(true);
  });

  it("should_disable_begin_review_when_pull_request_is_missing", () => {
    expect(isBeginEnabled(false)).to.equal(false);
  });

  it("should_disable_pull_request_cards_when_repository_is_not_selected", () => {
    expect(areCardsDisabled(false)).to.equal(true);
  });

  it("should_render_accessible_graph_summary_when_webgl_fails", () => {
    expect(shouldShowGraphSummary(false)).to.equal(true);
  });

  it("should_render_no_findings_state_when_review_is_clean", () => {
    expect(shouldShowCleanState(0)).to.equal(true);
  });
});

describe("Review phase typing", () => {
  it("should_map_idle_when_phase_is_empty", () => {
    expect(toReviewPhase(undefined)).to.equal("idle");
    expect(toReviewPhase("")).to.equal("idle");
  });

  it("should_strip_detail_suffix_from_raw_phase", () => {
    expect(toReviewPhase("failed:llm_provider_timeout")).to.equal("failed");
    expect(toReviewPhase("diff_dag:nodes=42")).to.equal("diff_dag");
  });

  it("should_fall_back_to_idle_for_unknown_phase", () => {
    expect(toReviewPhase("totally_made_up")).to.equal("idle");
  });

  it("should_recognize_every_declared_phase", () => {
    for (const phase of REVIEW_PHASES) {
      expect(toReviewPhase(phase)).to.equal(phase);
    }
  });
});

describe("Review stage projection", () => {
  it("should_activate_only_the_graph_stage_when_in_diff_dag", () => {
    const stages = computeReviewStages("diff_dag");
    const active = stages.filter((stage) => stage.active).map((stage) => stage.key);
    expect(active).to.deep.equal(["graph"]);
  });

  it("should_mark_earlier_stages_done_when_in_tcsrct", () => {
    const stages = computeReviewStages("tcsrct");
    const byKey = Object.fromEntries(stages.map((stage) => [stage.key, stage]));
    expect(byKey["queued"].done).to.equal(true);
    expect(byKey["graph"].done).to.equal(true);
    expect(byKey["wetting"].done).to.equal(true);
    expect(byKey["tcsrct"].active).to.equal(true);
    expect(byKey["llm"].done).to.equal(false);
  });

  it("should_complete_all_stages_when_review_completed", () => {
    const stages = computeReviewStages("completed");
    expect(stages.every((stage) => stage.done || stage.key === "complete")).to.equal(true);
    expect(stages.find((stage) => stage.key === "complete")?.active).to.equal(true);
  });

  it("should_leave_all_stages_inactive_when_failed", () => {
    const stages = computeReviewStages("failed");
    expect(stages.some((stage) => stage.active)).to.equal(false);
  });
});


import { countOpenPullRequests } from "../src/app/state/rules";

describe("countOpenPullRequests", () => {
  it("should_count_open_and_draft_but_not_closed_or_merged", () => {
    const count = countOpenPullRequests([
      { state: "open" },
      { state: "draft" },
      { state: "closed" },
      { state: "merged" },
    ]);
    expect(count).to.equal(2);
  });

  it("should_return_zero_for_an_all_closed_history_list", () => {
    expect(countOpenPullRequests([{ state: "closed" }, { state: "merged" }])).to.equal(0);
  });

  it("should_treat_missing_state_as_open_rather_than_zeroing_the_stat", () => {
    expect(countOpenPullRequests([{}, { state: "open" }])).to.equal(2);
  });

  it("should_return_zero_for_an_empty_list", () => {
    expect(countOpenPullRequests([])).to.equal(0);
  });
});

import { isStopArmed } from "../src/app/state/rules";

describe("isStopArmed (cooperative cancellation, client side)", () => {
  it("should_arm_stop_while_the_local_run_is_in_flight", () => {
    expect(isStopArmed("reviewing", false)).to.equal(true);
    expect(isStopArmed("graphing", false)).to.equal(true);
    expect(isStopArmed("queued", false)).to.equal(true);
  });

  it("should_disarm_stop_for_terminal_run_states_without_a_live_session", () => {
    expect(isStopArmed("completed", false)).to.equal(false);
    expect(isStopArmed("cancelled", false)).to.equal(false);
    expect(isStopArmed("failed", false)).to.equal(false);
  });

  it("should_arm_stop_from_the_attached_session_after_a_refresh", () => {
    // Local run object not yet rehydrated (null), but the server session is live.
    expect(isStopArmed(null, true)).to.equal(true);
    expect(isStopArmed("completed", true)).to.equal(true);
  });

  it("should_disarm_stop_with_no_run_and_no_live_session", () => {
    expect(isStopArmed(null, false)).to.equal(false);
  });
});

describe("isStopArmed during the cancelling transition (#38)", () => {
  it("should_disarm_stop_while_a_stop_is_already_in_flight", () => {
    // Even with the server session still active — the loop is landing it.
    expect(isStopArmed("cancelling", true)).to.equal(false);
    expect(isStopArmed("cancelling", false)).to.equal(false);
  });
});

describe("windowRepositories (1000+ repo picker window)", () => {
  const repos = Array.from({ length: 1200 }, (_, i) => ({ id: String(i + 1) }));

  it("should_window_large_unfiltered_lists_to_the_cap", () => {
    const { visible, hiddenCount } = windowRepositories(repos, false, null, 100);
    expect(visible.length).to.equal(100);
    expect(hiddenCount).to.equal(1100);
    expect(visible[0].id).to.equal("1");
  });

  it("should_keep_the_current_selection_visible_beyond_the_cap", () => {
    const { visible, hiddenCount } = windowRepositories(repos, false, "777", 100);
    expect(visible.length).to.equal(101);
    expect(visible.some((repo) => repo.id === "777")).to.equal(true);
    expect(hiddenCount).to.equal(1099);
  });

  it("should_lift_the_window_while_filtering_or_under_the_cap", () => {
    expect(windowRepositories(repos, true, null, 100).visible.length).to.equal(1200);
    expect(windowRepositories(repos, true, null, 100).hiddenCount).to.equal(0);
    const small = repos.slice(0, 40);
    expect(windowRepositories(small, false, null, 100).visible.length).to.equal(40);
  });
});

describe("seedPostedState (shared posted-state from run records)", () => {
  it("should_seed_posted_maps_from_persisted_artifacts", () => {
    const seed = seedPostedState([
      { kind: "inline", findingId: "f1", url: "https://gh/c/1", postedAt: "t1" },
      { kind: "suggestion", findingId: "f2", url: "https://gh/s/2", postedAt: "t2" },
      { kind: "summary", url: "https://gh/pr/3", postedAt: "t3" },
    ]);
    expect(seed.commentState).to.deep.equal({ f1: "posted" });
    expect(seed.commentUrl).to.deep.equal({ f1: "https://gh/c/1" });
    expect(seed.suggestionState).to.deep.equal({ f2: "posted" });
    expect(seed.suggestionUrl).to.deep.equal({ f2: "https://gh/s/2" });
    expect(seed.prCommentUrl).to.equal("https://gh/pr/3");
  });

  it("should_return_empty_seeds_for_missing_or_empty_artifacts", () => {
    const empty = seedPostedState(undefined);
    expect(empty.commentState).to.deep.equal({});
    expect(empty.prCommentUrl).to.equal(null);
    expect(seedPostedState([]).prCommentUrl).to.equal(null);
  });

  it("should_ignore_finding_scoped_artifacts_without_a_finding_id", () => {
    const seed = seedPostedState([
      { kind: "inline", url: "https://gh/c/1", postedAt: "t1" },
    ]);
    expect(seed.commentState).to.deep.equal({});
  });
});

describe("watchersLabel (session presence chip)", () => {
  it("should_label_multi_viewer_live_sessions", () => {
    expect(watchersLabel(true, 3)).to.equal("3 watching");
    expect(watchersLabel(true, 2)).to.equal("2 watching");
  });

  it("should_hide_presence_for_lone_viewers_finished_sessions_and_old_apis", () => {
    expect(watchersLabel(true, 1)).to.equal(null);
    expect(watchersLabel(true, 0)).to.equal(null);
    expect(watchersLabel(true, undefined)).to.equal(null);
    expect(watchersLabel(false, 5)).to.equal(null);
  });
});
