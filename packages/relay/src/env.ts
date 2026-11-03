import type { RoomRelay } from "./room-relay.js";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}
