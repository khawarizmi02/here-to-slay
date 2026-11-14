import { afterEach, describe, expect, it } from "vitest";
import { checkDeadlinesWhenVisible } from "../src/root/launcher.js";

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => setVisibility("visible"));

describe("the Host's tab", () => {
  it("has the Room check its deadlines each time it becomes visible, until it stops", () => {
    let checks = 0;
    const stop = checkDeadlinesWhenVisible({ checkDeadlines: () => checks++ }, document);
    setVisibility("hidden");
    expect(checks).toBe(0);
    setVisibility("visible");
    expect(checks).toBe(1);

    stop();
    setVisibility("hidden");
    setVisibility("visible");
    expect(checks).toBe(1);
  });
});
