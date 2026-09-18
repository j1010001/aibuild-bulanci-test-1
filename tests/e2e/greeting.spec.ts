import { test, expect } from "@playwright/test";

// Issue #1 acceptance criterion: "Given the home page has loaded, When the
// user sees the screen, Then the exact text 'Jan's first test' is present."
test("home page displays the exact greeting text", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("canvas", { state: "attached" });

  await expect(page.getByText("Jan's first test", { exact: true })).toBeVisible();
});
