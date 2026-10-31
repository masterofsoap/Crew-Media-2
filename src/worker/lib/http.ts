import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType, ZodTypeDef } from "zod";

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const bad = (msg: string, code = "BAD_REQUEST", fields?: Record<string, string>) => new HttpError(400, code, msg, fields);
export const unauthorized = (msg = "Please sign in.") => new HttpError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found.") => new HttpError(404, "NOT_FOUND", msg);
export const conflict = (msg: string, code = "CONFLICT") => new HttpError(409, code, msg);
export const tooMany = (msg = "Too many requests. Please slow down.") => new HttpError(429, "RATE_LIMITED", msg);

export async function body<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw bad("Request body must be JSON.");
  }
  return parse(schema, raw);
}

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) fields[issue.path.join(".") || "_"] = issue.message;
    const first = r.error.issues[0];
    throw bad(first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", "VALIDATION", fields);
  }
  return r.data;
}

export function query<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): T {
  return parse(schema, c.req.query());
}

export function encodeCursor(v: unknown): string {
  return btoa(JSON.stringify(v)).replace(/=+$/, "");
}

export function decodeCursor<T>(s: string | undefined | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(atob(s)) as T;
  } catch {
    throw bad("Invalid cursor.");
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function placeholders(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `?${i + start}`).join(",");
}
