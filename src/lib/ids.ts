// Every record in the library (sheets, sets, text annotations) is keyed by a
// UUID generated here.
//
// `crypto.randomUUID()` is restricted to secure contexts — HTTPS, or a
// `localhost` hostname. Open a dev build from a phone on the same wifi and the
// origin is a bare LAN IP over plain HTTP, which is neither, so the method is
// simply absent and every "new sheet" / "import" throws
// "crypto.randomUUID is not a function". `crypto.getRandomValues()` carries no
// such restriction, so build the same v4 layout from it instead.

export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
    hex.slice(16, 20) + "-" + hex.slice(20)
  );
}
