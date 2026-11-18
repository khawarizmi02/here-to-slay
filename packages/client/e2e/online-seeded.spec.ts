import { expect, test, type Page } from "@playwright/test";
import { gameOver, hand, hostingNotice, respond, skipAnimations, takeOneAction, waitingForHost } from "./play.js";

/** Seeds the Room's random in the Host's tab, which fixes the game's seed and so the whole game. */
const SEED = "slay-e2e";
/** Who wins the game `SEED` deals under the policy below, and the final scores. */
const WINNER = "Alice";
const FINAL_SCORES = [/^Alice\s+9 points/, /^Bob\s+7 points/, /^Carol\s+7 points/];
const FRIEND_REFRESH_TURN = 3;
const HOST_REFRESH_TURN = 6;

const waitingForResponses = (page: Page) => page.getByRole("status").filter({ hasText: "Waiting for responses…" });
const turnLine = (page: Page) => page.locator("main.board > p").first();
const canDraw = (page: Page) => page.getByRole("button", { name: "Draw a card" }).and(page.locator(":enabled"));

/** The turn on `page`'s board, or null once the board is gone. */
async function turnOn(page: Page): Promise<number | null> {
  if (!(await turnLine(page).isVisible())) return null;
  const match = /^Turn (\d+):/.exec(await turnLine(page).innerText());
  return match ? Number(match[1]) : null;
}

/**
 * The proof that a full online game works (#11): a Host and two friends,
 * each in their own browser context (tabs in one profile share the Room
 * pointer), play the game `SEED` deals through a local relay to game over,
 * with animations skipped. Policy: on your turn, take the first offered
 * action; in a response window, pass; in a decision, take the first option.
 * Always passing means the order passes arrive in can't change the winner.
 *
 * Along the way, each at the start of a fixed turn, before its first
 * action: a friend refreshes and is back in the same Seat with the same
 * hand, and the Host's tab goes away and comes back, the friends waiting
 * for them meanwhile. And once, when the Host holds a usable card in a
 * response window, the Host holds off passing until both friends show
 * "Waiting for responses…".
 */
test("a Host and two friends play a seeded game to its known winner", async ({ browser }) => {
  test.setTimeout(300_000);
  const [host, bob, carol] = await Promise.all([0, 1, 2].map(async () => (await browser.newContext()).newPage()));
  const friends = [bob!, carol!];
  const everyone = [host!, ...friends];

  await host!.goto(`/?seed=${SEED}`);
  await host!.getByLabel("Your name").fill("Alice");
  await host!.getByRole("button", { name: "Host online" }).click();
  const code = (await host!.locator(".room-code").innerText()).trim();
  for (const [friend, name] of [[bob!, "Bob"], [carol!, "Carol"]] as const) {
    await friend.goto("/");
    await friend.getByLabel("Your name").fill(name);
    await friend.getByLabel("Room Code").fill(code);
    await friend.getByRole("button", { name: "Join with a Room Code" }).click();
    await expect(friend.locator(".room-code")).toHaveText(code);
  }
  await expect(host!.getByRole("listitem")).toHaveText([/Alice/, /Bob/, /Carol/]);
  for (const page of everyone) await skipAnimations(page);
  await host!.getByLabel("Target score").fill("8");
  await host!.getByRole("button", { name: "Start game" }).click();

  let friendRefreshed = false;
  let hostRefreshed = false;
  let heldPass = false;
  for (let n = 0; n < 1000; n++) {
    if ((await Promise.all(everyone.map((p) => gameOver(p).isVisible()))).every(Boolean)) break;
    const turn = await turnOn(host!);
    // A turn's start: nobody responding or deciding, and whoever's turn it is can draw.
    const atTurnStart = turn !== null && (await Promise.all(everyone.map((p) => canDraw(p).isVisible()))).some(Boolean);

    if (!friendRefreshed && atTurnStart && turn === FRIEND_REFRESH_TURN) {
      friendRefreshed = true;
      const bobsHand = await hand(bob!).innerText();
      await bob!.reload();
      await expect(hand(bob!)).toHaveText(bobsHand, { useInnerText: true });
      await expect(turnLine(bob!)).toHaveText(new RegExp(`^Turn ${FRIEND_REFRESH_TURN}:`));
      await skipAnimations(bob!);
      continue;
    }

    if (!hostRefreshed && atTurnStart && turn === HOST_REFRESH_TURN) {
      hostRefreshed = true;
      await expect(hostingNotice(host!)).toBeVisible();
      for (const friend of friends) await expect(hostingNotice(friend)).toHaveCount(0);
      await host!.goto("about:blank");
      for (const friend of friends) await expect(waitingForHost(friend)).toBeVisible();
      // The pointer brings the Host back to their Room: no seed needed, the game's is in the record.
      await host!.goto("/");
      await expect(hostingNotice(host!)).toBeVisible();
      await expect(turnLine(host!)).toHaveText(new RegExp(`^Turn ${HOST_REFRESH_TURN}:`));
      for (const friend of friends) await expect(waitingForHost(friend)).toHaveCount(0);
      await skipAnimations(host!);
      continue;
    }

    if (!heldPass && (await respond(host!).getByRole("button", { name: /^Play / }).count()) > 0) {
      heldPass = true;
      // The friends pass, or played the card: either way they wait on someone they aren't told of.
      for (const friend of friends) await takeOneAction(friend, { remote: true });
      for (const friend of friends) await expect(waitingForResponses(friend)).toBeVisible();
      await expect(respond(host!).getByRole("button", { name: "Pass" })).toBeVisible();
      await takeOneAction(host!);
      continue;
    }

    let acted = false;
    for (const [i, page] of everyone.entries()) {
      if (await takeOneAction(page, { remote: i > 0 })) {
        acted = true;
        break;
      }
    }
    if (!acted) await host!.waitForTimeout(100);
  }

  expect({ friendRefreshed, hostRefreshed, heldPass }).toEqual({ friendRefreshed: true, hostRefreshed: true, heldPass: true });
  for (const page of everyone) await expect(gameOver(page)).toHaveText(`${WINNER} wins!`);
  for (const page of everyone) await expect(page.locator("table.scores tr")).toHaveText(FINAL_SCORES, { useInnerText: true });
});
