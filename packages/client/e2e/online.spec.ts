import { expect, test } from "@playwright/test";
import { gameOver, hostingNotice, shortGame, skipAnimations, takeOneAction } from "./play.js";

/**
 * A Host and a friend, each in their own browser context (tabs in one
 * profile share the Room pointer), play through the relay to game over.
 * The friend types the Room Code in lower case with stray spaces.
 * A short game, policy as in the walking skeleton, with animations skipped.
 */
test("a Host and a friend play through the relay to game over", async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await (await browser.newContext()).newPage();
  const friend = await (await browser.newContext()).newPage();

  await host.goto("/");
  await host.getByLabel("Your name").fill("Alice");
  await host.getByRole("button", { name: "Host online" }).click();
  const code = (await host.locator(".room-code").innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
  await expect(hostingNotice(host)).toBeVisible();
  await skipAnimations(host);
  await shortGame(host);

  await friend.goto("/");
  await friend.getByLabel("Your name").fill("Bob");
  await friend.getByLabel("Room Code").fill(`  ${code.toLowerCase()} `);
  await friend.getByRole("button", { name: "Join with a Room Code" }).click();
  await expect(friend.getByRole("listitem")).toHaveCount(2);
  await expect(friend.locator(".room-code")).toHaveText(code);
  await skipAnimations(friend);
  // A friend sees none of the Host's controls, and isn't hosting.
  await expect(friend.getByRole("button", { name: "Start game" })).toHaveCount(0);
  await expect(friend.getByRole("button", { name: "Add a bot" })).toHaveCount(0);
  await expect(friend.getByLabel("Monsters to win")).toHaveCount(0);
  await expect(hostingNotice(friend)).toHaveCount(0);

  await expect(host.getByRole("listitem")).toHaveCount(2);
  await host.getByRole("button", { name: "Start game" }).click();

  for (let n = 0; n < 500; n++) {
    if ((await gameOver(host).isVisible()) && (await gameOver(friend).isVisible())) break;
    if (!(await takeOneAction(host)) && !(await takeOneAction(friend, { remote: true }))) await host.waitForTimeout(100);
  }
  const winner = (await gameOver(host).innerText()).trim();
  expect(winner).toMatch(/^(Alice|Bob) wins!$/);
  await expect(gameOver(friend)).toHaveText(winner);
  await expect(hostingNotice(host)).toBeVisible();
  await expect(hostingNotice(friend)).toHaveCount(0);
});

test("a Room Code with no Room behind it gets a clear message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Bob");
  await page.getByLabel("Room Code").fill("zzzzz");
  await page.getByRole("button", { name: "Join with a Room Code" }).click();
  await expect(page.getByRole("alert")).toHaveText("There is no Room ZZZZZ. It may have closed; ask the Host for a new Room Code.");
  await expect(page.getByRole("button", { name: "Join with a Room Code" })).toBeVisible();
});
