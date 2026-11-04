/** Engine state, cards, views and events are plain JSON, so a JSON round-trip is a faithful deep copy. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
