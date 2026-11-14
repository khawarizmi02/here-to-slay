import { expect, test, type Page } from "@playwright/test";

const gameOver = (page: Page) => page.getByRole("heading", { name: /wins!$/ });

/**
 * One person plays a bot to game over on this device, with no relay. Policy:
 * pass in a response window, take the first option in a decision, and on
 * your turn play the first playable card, or draw.
 */
test("one player beats a bot, or loses to it, on this device", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Start game" }).click();

  for (let step = 0; step < 200 && !(await gameOver(page).isVisible()); step++) {
    await takeOneAction(page);
    // A lone local Seat never sees the Pass-Device Step.
    await expect(page.getByText(/pass the device/i)).toHaveCount(0);
  }
  await expect(gameOver(page)).toHaveText(/^(Alice|Bot 1) wins!$/);
});

test("the Host's rules set the game: hand size and target score", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await page.getByLabel("Hand size").fill("5");
  await page.getByLabel("Target score").fill("1");
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Start game" }).click();

  await expect(page.getByRole("region", { name: "Your hand" }).getByRole("button")).toHaveCount(5);
  for (let step = 0; step < 200 && !(await gameOver(page).isVisible()); step++) await takeOneAction(page);
  await expect(gameOver(page)).toBeVisible();
  // A target of 1 ends the game on the first score.
  await page.getByText("Game log").click();
  await expect(page.getByRole("list", { name: "Game log" }).getByText(/ scored /)).toHaveCount(1);
});

async function takeOneAction(page: Page): Promise<void> {
  const pass = page.getByRole("region", { name: "Respond" }).getByRole("button", { name: "Pass" });
  const decision = page.getByRole("dialog").getByRole("button").first();
  const card = page.getByRole("region", { name: "Your hand" }).getByRole("button").and(page.locator(":enabled")).first();
  const draw = page.getByRole("button", { name: "Draw a card" }).and(page.locator(":enabled"));

  // Wait until the board offers something to do.
  await expect(pass.or(decision).or(card).or(draw).or(gameOver(page)).first()).toBeVisible();
  for (const target of [pass, decision, card, draw]) {
    if (await target.isVisible()) {
      await target.click();
      return;
    }
  }
}
