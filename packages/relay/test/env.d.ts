import type { Env as RelayEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends RelayEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index.js");
    }
  }
}
