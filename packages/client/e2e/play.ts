import { expect, type Page } from "@playwright/test";

// Playing an online game through real buttons, shared by the online runs.

export const gameOver = (page: Page) => page.getByRole("heading", { name: /wins!$/ });
export const respond = (page: Page) => page.getByRole("region", { name: "Respond" });
export const hostingNotice = (page: Page) => page.getByText("Keep this tab open: you are hosting");
export const waitingForHost = (page: Page) => page.getByRole("status").filter({ hasText: "Waiting for Host…" });
export const hand = (page: Page) => page.getByRole("region", { name: "Your hand" });

/**
 * Ticks "Skip animations": the online runs play whole games, and leave the
 * animation queue to the client tests. The toggle isn't kept, so a page
 * ticks it again after each load.
 */
export async function skipAnimations(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "Skip animations" }).check();
}

/** The screen's text, without the countdown, which changes by itself. */
const screenText = (page: Page) =>
  page.locator("main").evaluate((main) => {
    const copy = main.cloneNode(true) as HTMLElement;
    for (const timer of copy.querySelectorAll("[role=timer]")) timer.remove();
    return copy.textContent;
  });

const enabled = (page: Page) => page.locator(":enabled");

/**
 * What the board offers, in the order the e2e policy takes it: pass in a
 * response window, take the first option of a decision, pick the first hero
 * for an item, attack a monster, play a card, roll for a hero, draw, and
 * only then end the turn. Attacking first keeps games short.
 */
export function boardTargets(page: Page) {
  return [
    respond(page).getByRole("button", { name: "Pass" }),
    page.getByRole("dialog").getByRole("button").and(enabled(page)).first(),
    page.getByRole("region", { name: /^Equip / }).getByRole("button").first(),
    page.getByRole("button", { name: /^Attack / }).and(enabled(page)).first(),
    hand(page).getByRole("button").and(enabled(page)).first(),
    page.getByRole("button", { name: /^Roll for / }).and(enabled(page)).first(),
    page.getByRole("button", { name: "Draw a card" }).and(enabled(page)),
    page.getByRole("button", { name: "End turn" }).and(enabled(page)),
  ];
}

/** Something the player can do on their own turn. */
export const enabledMove = (page: Page) => page.getByRole("button", { name: "End turn" }).and(enabled(page));

/** Clicks the first thing the board offers, if anything. Returns whether it did. */
export async function clickFirst(page: Page): Promise<boolean> {
  for (const target of boardTargets(page)) {
    if (await target.isVisible()) {
      await target.click();
      return true;
    }
  }
  return false;
}

/** Sets the Host's rules for a short game: one slain monster wins. */
export async function shortGame(page: Page): Promise<void> {
  await page.getByLabel("Monsters to win").fill("1");
}

/**
 * Takes the first thing the board offers, if anything, and waits for the
 * Room's answer to change the screen, so nothing is sent twice. A remote
 * Seat holding a usable card in a response window must see a countdown.
 */
export async function takeOneAction(page: Page, { remote = false } = {}): Promise<boolean> {
  for (const target of boardTargets(page)) {
    if (!(await target.isVisible())) continue;
    if (remote && (await respond(page).getByRole("button", { name: /^Play / }).count()) > 0) {
      await expect(respond(page).getByRole("timer")).toHaveText(/^\d+s left$/);
    }
    const before = await screenText(page);
    await target.click();
    await expect.poll(() => screenText(page), { timeout: 10_000 }).not.toBe(before);
    return true;
  }
  return false;
}
