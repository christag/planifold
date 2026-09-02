import { z } from "zod";

/**
 * What the helper returns, whether it came from a language model or from
 * the rule-based fallback. Every suggestion is re-validated by the grammar
 * before a person sees it, so a wrong id never reaches the plan.
 */
export const SuggestedSlotSchema = z.object({
  id: z.string().describe("Slot id, e.g. integration, object, filter.0.field, source, operation, p.to"),
  type: z.enum(["option", "text", "ref"]).describe("option = an id from the catalog; text = free text typed by the user; ref = another piece's id"),
  value: z.string(),
});
export type SuggestedSlot = z.infer<typeof SuggestedSlotSchema>;

export const SuggestionSchema = z.object({
  title: z.string().describe("Short imperative title, e.g. 'Get pasta emails from Gmail'"),
  pieceId: z.string().nullable().describe("Existing piece to fill, or null to add a new piece"),
  kind: z.enum(["input", "transform", "output"]),
  slots: z.array(SuggestedSlotSchema),
  why: z.string().describe("One sentence on why this is the right next piece"),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const HelperResponseSchema = z.object({
  message: z.string().describe("What to say to the person. Plain text, short paragraphs. No markdown headers."),
  suggestions: z.array(SuggestionSchema).describe("Concrete fills the person can apply with one click. Zero to four."),
  questions: z.array(z.string()).describe("Things only the person can decide. Zero to three, each one sentence."),
  remember: z.array(z.string()).describe("Facts stated by the person that a builder must know later. Zero to three."),
});
export type HelperResponse = z.infer<typeof HelperResponseSchema>;

export interface HelperFocus {
  pieceId: string;
  slotId?: string;
}

export type HelperIntent = "chat" | "breakdown" | "slot" | "review";
