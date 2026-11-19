import { expect, test, type Page } from "@playwright/test";
import { boardTargets, clickFirst, gameOver, shortGame } from "./play.js";

const step = (page: Page) => page.getByRole("heading", { name: /^Pass the device to / });
const passButton = (page: Page) => page.getByRole("region", { name: "Respond" }).getByRole("button", { name: "Pass" });
const hand = (page: Page) => page.getByRole("region", { name: "Your hand" });
const offered = (page: Page) => {
  const [first, ...rest] = boardTargets(page);
  return rest.reduce((any, t) => any.or(t), first!).first();
};

/**
 * Alice and Bob share one device to game over. Each time the Pass-Device
 * Step shows, the hand is hidden and the named player takes the device.
 * Refreshes once at a turn's step and once in an open response window,
 * after the player asked has seen their options. Bob is only asked to
 * respond when he holds a usable card, so a game may end without that
 * window: then it plays another. Short games, policy as in the walking skeleton.
 */
test("two players share one device, through refreshes, to game over", async ({ page }) => {
  await page.goto("/");
  let refreshedAtStep = false;
  let refreshedInWindow = false;

  for (let game = 0; game < 10 && !refreshedInWindow; game++) {
    if (game > 0) await page.getByRole("button", { name: "Leave Room" }).click();
    await page.getByLabel("Your name").fill("Alice");
    await page.getByRole("button", { name: "Play on this device" }).click();
    await shortGame(page);
    await page.getByLabel("Player name").fill("Bob");
    await page.getByRole("button", { name: "Add a player on this device" }).click();
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Start game" }).click();
    // The first player is rolled for.
    await expect(step(page)).toHaveText(/^Pass the device to (Alice|Bob)$/);

    for (let n = 0; n < 600 && !(await gameOver(page).isVisible()); n++) {
      await expect(step(page).or(offered(page)).or(gameOver(page)).first()).toBeVisible();
      if (await step(page).isVisible()) {
        await expect(hand(page)).toHaveCount(0);
        const name = (await step(page).innerText()).replace("Pass the device to ", "");
        if (!refreshedAtStep && n > 0) {
          await page.reload();
          await expect(step(page)).toHaveText(`Pass the device to ${name}`);
          refreshedAtStep = true;
        }
        await page.getByRole("button", { name: `I'm ${name}` }).click();
        continue;
      }
      if (!refreshedInWindow && (await passButton(page).isVisible())) {
        // The device is in someone's hands: the Room asks again, behind the step.
        await page.reload();
        await expect(step(page)).toBeVisible();
        await expect(hand(page)).toHaveCount(0);
        const name = (await step(page).innerText()).replace("Pass the device to ", "");
        await page.getByRole("button", { name: `I'm ${name}` }).click();
        await expect(passButton(page)).toBeVisible();
        refreshedInWindow = true;
      }
      await clickFirst(page);
    }
    await expect(gameOver(page)).toHaveText(/^(Alice|Bob) wins!$/);
  }
  expect(refreshedAtStep).toBe(true);
  expect(refreshedInWindow).toBe(true);
});
