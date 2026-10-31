import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ALLOWED_IMAGE_MIME, ALLOWED_VIDEO_MIME, IMAGE_MAX_BYTES, MAX_MEDIA_PER_POST, POST_MAX_CHARS, VIDEO_MAX_BYTES } from "../../shared/constants";
import type { MediaView, PostView } from "../../shared/types";
import { errorMessage, patch, post, uploadMedia } from "../lib/api";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { Button, IconButton, Textarea } from "./ui";
import { useToast } from "./toast";
import { usePatchPost } from "./PostCard";

interface Pending {
  key: string;
  file: File;
  preview: string;
  progress: number;
  media?: MediaView;
  error?: string;
  abort?: () => void;
  alt: string;
}

export function validateFile(file: File): string | null {
  const isImg = (ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type);
  const isVid = (ALLOWED_VIDEO_MIME as readonly string[]).includes(file.type);
  if (!isImg && !isVid) return "Only JPEG, PNG, GIF, WebP images and MP4, WebM, MOV videos are supported.";
  if (isImg && file.size > IMAGE_MAX_BYTES) return `Images can be up to ${IMAGE_MAX_BYTES / 1048576} MB.`;
  if (isVid && file.size > VIDEO_MAX_BYTES) return `Videos can be up to ${VIDEO_MAX_BYTES / 1048576} MB.`;
  return null;
}

function Ring({ used }: { used: number }) {
  const pct = Math.min(1, used / POST_MAX_CHARS);
  const left = POST_MAX_CHARS - used;
  const r = 9;
  const c = 2 * Math.PI * r;
  const color = left < 0 ? "var(--c-danger)" : left < 40 ? "#f5a524" : "var(--c-accent)";
  return (
    <span className="inline-flex items-center gap-1.5" aria-live="polite">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={r} fill="none" stroke="var(--c-border)" strokeWidth="2.2" />
        <circle cx="11" cy="11" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 11 11)" strokeLinecap="round" />
      </svg>
      {left < 40 ? <span className={`text-xs tabular-nums ${left < 0 ? "text-danger" : "text-muted"}`}>{left}</span> : <span className="sr-only">{left} characters left</span>}
    </span>
  );
}

export function Composer({
  replyToId,
  quoteOfId,
  editPost,
  placeholder = "What's happening in your world?",
  autoFocus,
  onPosted,
}: {
  replyToId?: string;
  quoteOfId?: string;
  editPost?: PostView;
  placeholder?: string;
  autoFocus?: boolean;
  onPosted?: (p: PostView) => void;
}) {
  const { active } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const patchPost = usePatchPost();
  const [text, setText] = useState(editPost?.text ?? "");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 360)}px`;
  }, [text]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return null;
  const uploading = files.some((f) => !f.media && !f.error);
  const ready = files.filter((f) => f.media);
  const canPost = !busy && !uploading && text.length <= POST_MAX_CHARS && (text.trim().length > 0 || ready.length > 0 || !!quoteOfId) && !files.some((f) => f.error);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list].slice(0, MAX_MEDIA_PER_POST - files.length);
    for (const file of incoming) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const problem = validateFile(file);
      const pending: Pending = { key, file, preview: URL.createObjectURL(file), progress: 0, alt: "", error: problem ?? undefined };
      setFiles((f) => [...f, pending]);
      if (problem) continue;
      const up = uploadMedia(file, "post", (progress) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, progress } : x))));
      setFiles((f) => f.map((x) => (x.key === key ? { ...x, abort: up.abort } : x)));
      up.promise
        .then((media) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, media, progress: 1 } : x))))
        .catch((e) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, error: errorMessage(e) } : x))));
    }
  };

  const removeFile = (key: string) => {
    setFiles((f) => {
      const x = f.find((y) => y.key === key);
      x?.abort?.();
      if (x) URL.revokeObjectURL(x.preview);
      if (x?.media) void fetch(`/api/media/${x.media.id}`, { method: "DELETE", headers: { "X-Crew-Client": "1", "X-Crew-Profile": active.id } });
      return f.filter((y) => y.key !== key);
    });
  };

  const submit = async () => {
    if (!canPost) return;
    setBusy(true);
    setError(null);
    try {
      let result: PostView;
      if (editPost) {
        result = await patch<PostView>(`/posts/${editPost.id}`, { text });
        patchPost(editPost.id, () => result);
        toast("Post updated");
      } else {
        result = await post<PostView>("/posts", { text, mediaIds: ready.map((f) => f.media!.id), replyToId: replyToId ?? null, quoteOfId: quoteOfId ?? null });
        toast(replyToId ? "Reply posted" : "Posted");
        if (replyToId) patchPost(replyToId, (p) => ({ ...p, replyCount: p.replyCount + 1 }));
        void qc.invalidateQueries({ queryKey: ["feed"] });
        void qc.invalidateQueries({ queryKey: ["replies"] });
        void qc.invalidateQueries({ queryKey: ["timeline"] });
      }
      setText("");
      files.forEach((f) => URL.revokeObjectURL(f.preview));
      setFiles([]);
      onPosted?.(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-3">
      <div className="shrink-0" title={`Posting as @${active.handle}`}>
        <Avatar profile={active} size={44} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs text-muted">
          Posting as <span className="font-semibold text-fg">@{active.handle}</span>
        </div>
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={2}
          aria-label={placeholder}
          className="!border-0 !bg-transparent !p-0 !shadow-none text-lg"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        {files.length ? (
          <div className={`mt-2 grid gap-2 ${files.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {files.map((f) => (
              <div key={f.key} className="relative overflow-hidden rounded-xl border divider bg-surface2">
                {f.file.type.startsWith("video/") ? <video src={f.preview} className="h-40 w-full object-cover" muted /> : <img src={f.preview} alt="" className="h-40 w-full object-cover" />}
                <IconButton icon="close" label={`Remove ${f.file.name}`} onClick={() => removeFile(f.key)} className="absolute right-1 top-1 !bg-black/60 !text-white" size={16} />
                {!f.media && !f.error ? (
                  <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/30" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f.progress * 100)} aria-label={`Uploading ${f.file.name}`}>
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(f.progress * 100)}%` }} />
                  </div>
                ) : null}
                {f.error ? <div className="absolute inset-x-0 bottom-0 bg-danger/90 px-2 py-1 text-xs font-semibold text-white">{f.error}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {files.length > 0 ? <p className="mt-1.5 text-xs text-muted">Photos and videos expire 7 days after upload. Your post's text stays.</p> : null}
        {error ? (
          <p className="mt-2 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex items-center justify-between border-t divider pt-2">
          <div className="flex items-center gap-1 text-accent">
            {!editPost ? (
              <>
                <input ref={inputRef} type="file" accept={[...ALLOWED_IMAGE_MIME, ...ALLOWED_VIDEO_MIME].join(",")} multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
                <IconButton icon="image" label="Add photos or video" disabled={files.length >= MAX_MEDIA_PER_POST} onClick={() => inputRef.current?.click()} />
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {text.length > 0 ? <Ring used={text.length} /> : null}
            <Button onClick={() => void submit()} disabled={!canPost} loading={busy} size="sm">
              {editPost ? "Save" : replyToId ? "Reply" : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { Icon };
