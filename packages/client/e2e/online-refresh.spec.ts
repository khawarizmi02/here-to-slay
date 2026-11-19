import { expect, test, type Page } from "@playwright/test";
import { gameOver, hand, hostingNotice, skipAnimations, takeOneAction, waitingForHost } from "./play.js";


/** Takes `moves` actions between the two players, as the online run does. */
async function play(host: Page, friend: Page, moves: number): Promise<void> {
  for (let n = 0; n < moves; ) {
    if (await takeOneAction(host)) n++;
    else if (await takeOneAction(friend, { remote: true })) n++;
    else await host.waitForTimeout(100);
  }
}

/**
 * Refreshes are short hiccups online too (TECHNICAL_DESIGN.md §10.7): a
 * Host refresh in the lobby, a friend refresh mid-game and the Host away
 * mid-game, each recovered with nobody rejoining by hand. Each player has
 * their own browser context, as in the online run, with animations skipped.
 */
test("a Host and a friend come back from refreshes and play on to game over", async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await (await browser.newContext()).newPage();
  const friend = await (await browser.newContext()).newPage();

  await host.goto("/");
  await host.getByLabel("Your name").fill("Alice");
  await host.getByRole("button", { name: "Host online" }).click();
  const code = (await host.locator(".room-code").innerText()).trim();
  await friend.goto("/");
  await friend.getByLabel("Your name").fill("Bob");
  await friend.getByLabel("Room Code").fill(code);
  await friend.getByRole("button", { name: "Join with a Room Code" }).click();
  await expect(host.getByRole("listitem")).toHaveCount(2);
  await skipAnimations(host);
  await skipAnimations(friend);

  // The Host refreshes in the lobby: an empty lobby under the same Room Code, which the friend retakes by themself.
  await host.reload();
  await expect(host.locator(".room-code")).toHaveText(code);
  await expect(host.getByRole("listitem")).toHaveCount(2);
  await skipAnimations(host);
  await expect(friend.getByRole("listitem")).toHaveText([/Alice/, /Bob/]);
  await expect(waitingForHost(friend)).toHaveCount(0);
  // Two monsters to win: long enough that the game outlasts the refreshes below, short enough to finish.
  await host.getByLabel("Monsters to win").fill("2");
  await host.getByRole("button", { name: "Start game" }).click();
  await play(host, friend, 2);

  // The friend refreshes mid-game and is back in the same Seat, with the same hand.
  await expect(hand(friend)).toBeVisible();
  const bobsHand = await hand(friend).innerText();
  await friend.reload();
  await expect(hand(friend)).toHaveText(bobsHand, { useInnerText: true });
  await skipAnimations(friend);

  // The Host's tab goes away mid-game: the friend waits for them, and the game resumes when they're back.
  await play(host, friend, 2);
  await host.goto("about:blank");
  await expect(waitingForHost(friend)).toBeVisible();
  await host.goto("/");
  await expect(waitingForHost(friend)).toHaveCount(0);
  await expect(hostingNotice(host)).toBeVisible();
  await expect(hand(host)).toBeVisible();
  await skipAnimations(host);

  for (let n = 0; n < 500; n++) {
    if ((await gameOver(host).isVisible()) && (await gameOver(friend).isVisible())) break;
    if (!(await takeOneAction(host)) && !(await takeOneAction(friend, { remote: true }))) await host.waitForTimeout(100);
  }
  const winner = (await gameOver(host).innerText()).trim();
  expect(winner).toMatch(/^(Alice|Bob) wins!$/);
  await expect(gameOver(friend)).toHaveText(winner);
});
