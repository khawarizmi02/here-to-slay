import { expect, test, type Page } from "@playwright/test";
import { boardTargets, clickFirst, gameOver, hand, shortGame } from "./play.js";

/**
 * One person plays a bot to game over on this device, with no relay, in a
 * short game. Policy as `boardTargets` orders it.
 */
test("one player beats a bot, or loses to it, on this device", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await shortGame(page);
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Start game" }).click();

  for (let step = 0; step < 500 && !(await gameOver(page).isVisible()); step++) {
    await takeOneAction(page);
    // A lone local Seat never sees the Pass-Device Step.
    await expect(page.getByText(/pass the device/i)).toHaveCount(0);
  }
  await expect(gameOver(page)).toHaveText(/^(Alice|Bot 1) wins!$/);
});

test("the Host's rules set the game: hand size and monsters to win", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await page.getByLabel("Hand size").fill("2");
  await page.getByLabel("Monsters to win").fill("1");
  await page.getByLabel("Classes to win").fill("6");
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Start game" }).click();

  await expect(hand(page).getByRole("button")).toHaveCount(2);
  for (let step = 0; step < 500 && !(await gameOver(page).isVisible()); step++) await takeOneAction(page);
  await expect(gameOver(page)).toBeVisible();
  // One monster to win ends the game on the first one slain.
  await expect(page.getByText("By slaying monsters")).toBeVisible();
  await page.getByText("Game log").click();
  await expect(page.getByRole("list", { name: "Game log" }).getByText(/ slew /)).toHaveCount(1);
});

async function takeOneAction(page: Page): Promise<void> {
  // Wait until the board offers something to do.
  const [first, ...rest] = boardTargets(page);
  await expect(rest.reduce((any, t) => any.or(t), first!).or(gameOver(page)).first()).toBeVisible();
  await clickFirst(page);
}
