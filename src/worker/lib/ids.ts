const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Time-sortable ID: 9 base36 chars of ms timestamp + 12 random base36 chars. */
export function newId(now = Date.now()): string {
  const ts = now.toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 36];
  return ts + rand;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Human-friendly code from an unambiguous alphabet, grouped like ABCDE-FGHJK-... */
export function humanCode(groups = 4, size = 5): string {
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    const b = crypto.getRandomValues(new Uint8Array(size));
    parts.push([...b].map((x) => alpha[x % alpha.length]).join(""));
  }
  return parts.join("-");
}

export function dayKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}
