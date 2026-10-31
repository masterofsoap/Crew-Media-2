import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { REPORT_REASONS } from "../../shared/constants";
import { errorMessage, post } from "../lib/api";
import { Button, Dialog, Textarea } from "./ui";
import { useToast } from "./toast";

const LABELS: Record<string, string> = {
  spam: "Spam or misleading",
  harassment: "Harassment or bullying",
  privacy: "Shares private information",
  impersonation: "Impersonation",
  inappropriate: "Inappropriate for this community",
  other: "Something else",
};

export function ReportDialog({ open, onClose, targetType, targetId }: { open: boolean; onClose: () => void; targetType: "post" | "profile" | "message" | "media"; targetId: string }) {
  const [reason, setReason] = useState<string>("spam");
  const [details, setDetails] = useState("");
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => post("/reports", { targetType, targetId, reason, details }),
    onSuccess: () => {
      toast("Thanks — moderators will review this.");
      onClose();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Report ${targetType}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-semibold">What's wrong?</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface2">
              <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="accent-[var(--c-accent)]" />
              {LABELS[r]}
            </label>
          ))}
        </fieldset>
        <Textarea rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Add details (optional)" aria-label="Details" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending}>
            Submit report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
