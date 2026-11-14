import { expect, test, type Page } from "@playwright/test";

const gameOver = (page: Page) => page.getByRole("heading", { name: /wins!$/ });
const respond = (page: Page) => page.getByRole("region", { name: "Respond" });
const hostingNotice = (page: Page) => page.getByText("Keep this tab open: you are hosting");

/**
 * A Host and a friend, each in their own browser context (tabs in one
 * profile share the Room pointer), play through the relay to game over.
 * The friend types the Room Code in lower case with stray spaces.
 * Policy as in the walking skeleton.
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
  await host.getByLabel("Target score").fill("3");

  await friend.goto("/");
  await friend.getByLabel("Your name").fill("Bob");
  await friend.getByLabel("Room Code").fill(`  ${code.toLowerCase()} `);
  await friend.getByRole("button", { name: "Join with a Room Code" }).click();
  await expect(friend.getByRole("listitem")).toHaveCount(2);
  await expect(friend.locator(".room-code")).toHaveText(code);
  // A friend sees none of the Host's controls, and isn't hosting.
  await expect(friend.getByRole("button", { name: "Start game" })).toHaveCount(0);
  await expect(friend.getByRole("button", { name: "Add a bot" })).toHaveCount(0);
  await expect(friend.getByLabel("Target score")).toHaveCount(0);
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
async function takeOneAction(page: Page, { remote = false } = {}): Promise<boolean> {
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
