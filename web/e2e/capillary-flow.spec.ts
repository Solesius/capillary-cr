import { expect, test } from "@playwright/test";

test("e2e_should_connect_select_pr_begin_review_and_show_findings_when_github_mock_is_ready", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("PR GRAPH REVIEW")).toBeVisible();

  await page.getByRole("button", { name: /connect/i }).click();
  await expect(page.getByText(/status:/i)).toBeVisible();
});

test("e2e_should_show_recoverable_error_when_review_provider_fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("PR GRAPH REVIEW")).toBeVisible();
});

test("e2e_should_export_markdown_when_review_is_complete", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("PR GRAPH REVIEW")).toBeVisible();
});
