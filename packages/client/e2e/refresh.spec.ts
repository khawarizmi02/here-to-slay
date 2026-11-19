import { expect, test, type Page } from "@playwright/test";
import { boardTargets, clickFirst, enabledMove, gameOver, shortGame } from "./play.js";

const passButton = (page: Page) => page.getByRole("region", { name: "Respond" }).getByRole("button", { name: "Pass" });
/** The Room Code the Room saved its game under, read from IndexedDB rather than from the pointer. */
const savedRoomCodes = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("here-to-slay");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const keys = open.result.transaction("rooms", "readonly").objectStore("rooms").getAllKeys();
          keys.onerror = () => reject(keys.error);
          keys.onsuccess = () => resolve(keys.result.map(String));
        };
      }),
  );
const roomCode = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("here-to-slay.room") ?? "null") as { roomCode: string } | null)?.roomCode ?? null);

async function startAgainstABot(page: Page): Promise<void> {
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await shortGame(page);
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Start game" }).click();
  await untilAlicesTurn(page);
}

/**
 * Waits for Alice's turn, passing and deciding meanwhile: the first player
 * is rolled for. On her turn nothing can move until she does, so the board
 * holds still for a comparison.
 */
async function untilAlicesTurn(page: Page): Promise<void> {
  const pass = page.getByRole("region", { name: "Respond" }).getByRole("button", { name: "Pass" });
  const decision = page.getByRole("dialog").getByRole("button").and(page.locator(":enabled")).first();
  for (let n = 0; n < 50 && !(await enabledMove(page).isVisible()); n++) {
    await expect(enabledMove(page).or(pass).or(decision).first()).toBeVisible();
    if (await enabledMove(page).isVisible()) break;
    await (await pass.isVisible() ? pass : decision).click();
  }
  await expect(enabledMove(page)).toBeVisible();
}

/** Reloads, and checks the board comes back exactly as it was. */
async function refreshAndCompare(page: Page): Promise<void> {
  const before = await page.locator("main.board").innerText();
  await page.reload();
  await expect(page.locator("main.board")).toHaveText(before, { useInnerText: true });
}

test("a refresh in the lobby lands back in an empty lobby under the same Room Code", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Alice");
  await page.getByRole("button", { name: "Play on this device" }).click();
  await page.getByRole("button", { name: "Add a bot" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  const code = await roomCode(page);

  await page.reload();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem")).toContainText("Alice");

  // The rebuilt Room keeps the Room Code: the game it starts is saved under it.
  await page.getByRole("button", { name: "Add a bot" }).click();
  await page.getByRole("button", { name: "Start game" }).click();
  await untilAlicesTurn(page);
  await expect.poll(() => savedRoomCodes(page)).toEqual([code]);
});

/**
 * Refreshes once on Alice's turn and once while a response window waits on
 * her, then plays to game over. Alice is only asked to respond when she
 * holds a usable card, so a game may end without that window: then it plays
 * another. Short games, policy as in the walking skeleton.
 */
test("a refresh mid-game restores the same game, even in an open response window", async ({ page }) => {
  await page.goto("/");
  let refreshedInWindow = false;

  for (let game = 0; game < 10 && !refreshedInWindow; game++) {
    if (game > 0) await page.getByRole("button", { name: "Leave Room" }).click();
    await startAgainstABot(page);
    await refreshAndCompare(page);

    for (let step = 0; step < 500 && !(await gameOver(page).isVisible()); step++) {
      const [first, ...rest] = boardTargets(page);
      await expect(rest.reduce((any, t) => any.or(t), first!).or(gameOver(page)).first()).toBeVisible();
      if (!refreshedInWindow && (await passButton(page).isVisible())) {
        await refreshAndCompare(page);
        await expect(passButton(page)).toBeVisible();
        refreshedInWindow = true;
      }
      await clickFirst(page);
    }
    await expect(gameOver(page)).toBeVisible();
  }
  expect(refreshedInWindow).toBe(true);

  // Game over cleared the pointer: the next load starts fresh.
  await page.reload();
  await expect(page.getByRole("button", { name: "Play on this device" })).toBeVisible();
});
