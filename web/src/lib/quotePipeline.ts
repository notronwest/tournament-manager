import type { Database } from "../types/supabase";
import { courtBlue, courtGreen, courtRed, inkMuted } from "./publicTheme";

// The unified opportunity lifecycle, DERIVED from quote_status + whether a
// contract has been signed. This is display/filtering only — quote_status and
// contract_status stay the source of truth (no schema change). Later stages
// (In setup, Live) get wired when the setup-intake + quote→tournament link land.
//
//   New (submitted) → Drafting (draft) → Quoted (quoted, awaiting customer)
//   → Accepted (accepted, no signed contract) → Signed (accepted + signed)
//   Declined is a terminal off-ramp.

type QuoteStatus = Database["public"]["Enums"]["quote_status"];

export type PipelineStage =
  | "new"
  | "drafting"
  | "quoted"
  | "accepted"
  | "signed"
  | "declined";

export const STAGE_ORDER: PipelineStage[] = [
  "new",
  "drafting",
  "quoted",
  "accepted",
  "signed",
  "declined",
];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  new: "New",
  drafting: "Drafting",
  quoted: "Quoted",
  accepted: "Accepted",
  signed: "Signed",
  declined: "Declined",
};

export const STAGE_COLORS: Record<PipelineStage, string> = {
  new: courtBlue,
  drafting: inkMuted,
  quoted: "#b8860b", // amber — awaiting the customer
  accepted: courtGreen,
  signed: "#1e6b2c", // deep court-green — agreement in hand
  declined: courtRed,
};

// One-line hint of what to do next at each stage (shown in the pipeline).
export const STAGE_HINT: Record<PipelineStage, string> = {
  new: "New inquiry — review and start a quote",
  drafting: "Draft in progress — price it and send",
  quoted: "Sent — waiting on the customer",
  accepted: "Accepted — get the agreement signed",
  signed: "Signed — start the tournament setup",
  declined: "Declined",
};

// Stages shown by default in the pipeline (hide the Declined off-ramp).
export const DEFAULT_VISIBLE_STAGES: PipelineStage[] = STAGE_ORDER.filter(
  (s) => s !== "declined",
);

export function deriveStage(
  quoteStatus: QuoteStatus,
  hasSignedContract: boolean,
): PipelineStage {
  switch (quoteStatus) {
    case "declined":
      return "declined";
    case "accepted":
      return hasSignedContract ? "signed" : "accepted";
    case "quoted":
      return "quoted";
    case "draft":
      return "drafting";
    case "submitted":
    default:
      return "new";
  }
}
