import type { ApiError as ApiErrorBody, MediaView } from "../../shared/types";

/** The profile the UI believes it is acting as; sent on every mutation and verified server-side. */
let actingProfileId = "";
export function setActingProfile(id: string) {
  actingProfileId = id;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { "X-Crew-Client": "1" };
  if (actingProfileId) headers["X-Crew-Profile"] = actingProfileId;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "You appear to be offline. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>;
    if (err.code === "PROFILE_MISMATCH") window.dispatchEvent(new CustomEvent("crew:profile-mismatch"));
    if (res.status === 401 && path !== "/auth/session" && !path.startsWith("/auth/")) window.dispatchEvent(new CustomEvent("crew:unauthorized"));
    throw new ApiError(res.status, err.code ?? "ERROR", err.error ?? `Request failed (${res.status}).`, err.fields);
  }
  return data as T;
}

export const get = <T>(p: string, signal?: AbortSignal) => api<T>(p, { signal });
export const post = <T>(p: string, body: unknown = {}) => api<T>(p, { method: "POST", body });
export const patch = <T>(p: string, body: unknown = {}) => api<T>(p, { method: "PATCH", body });
export const put = <T>(p: string, body: unknown = {}) => api<T>(p, { method: "PUT", body });
export const del = <T>(p: string) => api<T>(p, { method: "DELETE" });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

async function dimensions(file: File): Promise<{ width?: number; height?: number }> {
  try {
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const d = { width: bmp.width, height: bmp.height };
      bmp.close();
      return d;
    }
    if (file.type.startsWith("video/")) {
      return await new Promise((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => {
          resolve({ width: v.videoWidth || undefined, height: v.videoHeight || undefined });
          URL.revokeObjectURL(v.src);
        };
        v.onerror = () => resolve({});
        v.src = URL.createObjectURL(file);
      });
    }
  } catch {
    /* unknown dimensions are fine */
  }
  return {};
}

/** Create a small JPEG thumbnail (image) or poster frame (video) in the browser. */
async function makeThumb(file: File): Promise<Blob | null> {
  try {
    let source: CanvasImageSource;
    let w: number;
    let h: number;
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      source = bmp;
      w = bmp.width;
      h = bmp.height;
    } else {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.src = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => {
        v.onloadeddata = () => {
          v.currentTime = Math.min(0.5, (v.duration || 1) / 4);
        };
        v.onseeked = () => resolve();
        v.onerror = () => reject(new Error("video decode failed"));
      });
      source = v;
      w = v.videoWidth;
      h = v.videoHeight;
    }
    const scale = Math.min(1, 480 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob((b) => r(b), "image/jpeg", 0.78));
  } catch {
    return null;
  }
}

/** Server-authorized upload with progress; the server validates type by content and size. */
export function uploadMedia(
  file: File,
  purpose: "post" | "message" | "profile",
  onProgress: (fraction: number) => void,
  alt = "",
): { promise: Promise<MediaView>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = (async () => {
    const dims = await dimensions(file);
    const qs = new URLSearchParams({ purpose, alt });
    if (dims.width) qs.set("width", String(dims.width));
    if (dims.height) qs.set("height", String(dims.height));
    const media = await new Promise<MediaView>((resolve, reject) => {
      xhr.open("POST", `/api/media?${qs.toString()}`);
      xhr.setRequestHeader("X-Crew-Client", "1");
      xhr.setRequestHeader("X-Crew-Profile", actingProfileId);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as MediaView);
        else reject(new ApiError(xhr.status, String(body.code ?? "UPLOAD_FAILED"), String(body.error ?? "Upload failed.")));
      };
      xhr.onerror = () => reject(new ApiError(0, "NETWORK", "Upload interrupted. Check your connection and try again."));
      xhr.onabort = () => reject(new ApiError(0, "ABORTED", "Upload cancelled."));
      xhr.send(file);
    });
    const thumb = await makeThumb(file);
    if (thumb) {
      await fetch(`/api/media/${media.id}/thumb`, {
        method: "PUT",
        headers: { "X-Crew-Client": "1", "X-Crew-Profile": actingProfileId, "Content-Type": "image/jpeg" },
        body: thumb,
      }).catch(() => undefined);
    }
    return media;
  })();
  return { promise, abort: () => xhr.abort() };
}
