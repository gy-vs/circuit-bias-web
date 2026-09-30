// Monotonic identity of the circuit document, used only to order edits.
// Electrical staleness is determined by the hash returned by the backend
// (backend/app/canonical.py), so this module never needs to reproduce
// Python's number-to-JSON formatting.
import type { Circuit } from "./types";

// Graphical-only fields are stripped before structural comparison so that
// moving a symbol or node does not invalidate results. The backend hash is
// still authoritative; this is merely a fast local edit-generation counter.
export function electricalSnapshot(c: Circuit): string {
  return JSON.stringify({
    g: c.ground,
    n: c.nodes.map((x) => x.id),
    c: c.components.map((x) => ({ t: x.type, n: x.nodes, p: x.params })),
    p: c.probes.map((x) => ({ a: x.plus, b: x.minus })),
  });
}
