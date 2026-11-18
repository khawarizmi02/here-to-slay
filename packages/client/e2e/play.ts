import { expect, type Page } from "@playwright/test";

// Playing an online game through real buttons, shared by the online runs.

export const gameOver = (page: Page) => page.getByRole("heading", { name: /wins!$/ });
export const respond = (page: Page) => page.getByRole("region", { name: "Respond" });
export const hostingNotice = (page: Page) => page.getByText("Keep this tab open: you are hosting");

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

/**
 * Takes the first thing the board offers, if anything, and waits for the
 * Room's answer to change the screen, so nothing is sent twice. A remote
 * Seat holding a usable card in a response window must see a countdown.
 */
export async function takeOneAction(page: Page, { remote = false } = {}): Promise<boolean> {
  const pass = respond(page).getByRole("button", { name: "Pass" });
  const decision = page.getByRole("dialog").getByRole("button").and(page.locator(":enabled")).first();
  const card = page.getByRole("region", { name: "Your hand" }).getByRole("button").and(page.locator(":enabled")).first();
  const draw = page.getByRole("button", { name: "Draw a card" }).and(page.locator(":enabled"));
  for (const target of [pass, decision, card, draw]) {
    if (!(await target.isVisible())) continue;
    if (remote && target === pass && (await respond(page).getByRole("button", { name: /^Play / }).count()) > 0) {
      await expect(respond(page).getByRole("timer")).toHaveText(/^\d+s left$/);
    }
    const before = await screenText(page);
    await target.click();
    await expect.poll(() => screenText(page), { timeout: 10_000 }).not.toBe(before);
    return true;
  }
  return false;
}
