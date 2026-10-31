/** Content sniffing by magic bytes. The declared Content-Type must agree with the sniffed type. */
export type Sniffed = { mime: string; kind: "image" | "video" } | null;

export function sniff(b: Uint8Array): Sniffed {
  const at = (i: number) => b[i] ?? -1;
  const ascii = (start: number, len: number) => String.fromCharCode(...b.slice(start, start + len));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mime: "image/jpeg", kind: "image" };
  if (at(0) === 0x89 && ascii(1, 3) === "PNG" && at(4) === 0x0d && at(5) === 0x0a) return { mime: "image/png", kind: "image" };
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { mime: "image/gif", kind: "image" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mime: "image/webp", kind: "image" };
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return { mime: "video/webm", kind: "video" };
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "qt  ") return { mime: "video/quicktime", kind: "video" };
    if (/^(isom|iso2|iso4|iso5|iso6|mp41|mp42|avc1|M4V |dash|MSNV|3gp4|3gp5)/.test(brand)) return { mime: "video/mp4", kind: "video" };
    if (/^(heic|heix|mif1|avif)/.test(brand)) return null; // not supported for display in all browsers
  }
  return null;
}

/** Declared types that are acceptable aliases of a sniffed type. */
export function declaredMatches(declared: string, sniffed: string): boolean {
  const d = declared.split(";")[0]!.trim().toLowerCase();
  if (d === sniffed) return true;
  if (sniffed === "image/jpeg" && d === "image/jpg") return true;
  if (sniffed === "video/mp4" && (d === "video/x-m4v" || d === "video/quicktime")) return true;
  if (sniffed === "video/quicktime" && d === "video/mp4") return true;
  return false;
}

/**
 * Read enough of a stream to sniff its type, then return a stream that replays those bytes
 * followed by the remainder, enforcing an exact byte length.
 */
export async function peekStream(stream: ReadableStream<Uint8Array>, need = 32): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < need) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const head = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    head.set(c, off);
    off += c.byteLength;
  }
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream: replay };
}

export function mediaHeaders(mime: string, size: number, maxAgeSec: number): Headers {
  const h = new Headers();
  h.set("Content-Type", mime);
  h.set("Content-Length", String(size));
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Content-Disposition", "inline");
  h.set("Content-Security-Policy", "default-src 'none'; sandbox");
  h.set("Cache-Control", `private, max-age=${Math.max(0, Math.floor(maxAgeSec))}`);
  h.set("Accept-Ranges", "bytes");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return h;
}

export function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] !== "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}
