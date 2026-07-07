import { expect } from "chai";
import {
  areCardsDisabled,
  computeReviewStages,
  isBeginEnabled,
  shouldShowCleanState,
  shouldShowGraphSummary,
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

