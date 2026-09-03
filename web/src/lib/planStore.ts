import { analyzePlan, buildSentence, cleanPiece, withSlot, type PieceData, type PieceKind, type PlanAnalysis, type SlotValue } from "@planifold/shared";
import { create } from "zustand";
import { api } from "./api.js";
import { errorMessage, useApp } from "./store.js";
import type { HelperMessage, HelperResult, Piece, Plan, Suggestion } from "./types.js";

export type View = "pieces" | "map" | "handoff";

interface PlanState {
  plan: Plan | null;
  pieces: Piece[];
  messages: HelperMessage[];
  analysis: PlanAnalysis | null;
  loading: boolean;
  error: string | null;
  saving: number;
  view: View;
  focusId: string | null;
  openSlot: string | null;
  helperOpen: boolean;
  planSheetOpen: boolean;
  helperBusy: boolean;
  justCompleted: string | null;

  load(id: string): Promise<void>;
  reset(): void;
  setView(v: View): void;
  focus(id: string | null, slot?: string | null): void;
  setOpenSlot(slotId: string | null): void;
  setHelperOpen(open: boolean): void;
  setPlanSheetOpen(open: boolean): void;
  setPieces(pieces: Piece[]): void;

  setSlot(pieceId: string, slotId: string, value: SlotValue | undefined): Promise<void>;
  addPiece(kind: PieceKind, opts?: { focus?: boolean }): Promise<Piece | null>;
  removePiece(id: string): Promise<void>;
  renamePiece(id: string, label: string | null): Promise<void>;
  setNotes(id: string, notes: string): Promise<void>;
  updatePlan(patch: Partial<Pick<Plan, "title" | "thought" | "facts" | "status">>): Promise<void>;
  addFact(text: string): Promise<void>;
  removeFact(index: number): Promise<void>;

  ask(input: { message?: string; intent: "chat" | "breakdown" | "slot" | "review"; focus?: { pieceId: string; slotId?: string } }): Promise<HelperResult | null>;
  applySuggestion(s: Suggestion): Promise<void>;
  clearHelper(): Promise<void>;
  writeBrief(): Promise<void>;
}

/** Per-piece request counters so a slow response never overwrites a newer fill. */
const slotRequests = new Map<string, number>();

export const toData = (p: Piece): PieceData => ({ id: p.id, kind: p.kind, slots: p.slots, label: p.label, notes: p.notes, position: p.position });

function analyze(pieces: Piece[]): PlanAnalysis | null {
  const catalog = useApp.getState().catalog;
  return catalog ? analyzePlan(pieces.map(toData), catalog) : null;
}

/** The next required blank in a piece, if any. */
export function nextBlank(pieces: Piece[], pieceId: string): string | null {
  const catalog = useApp.getState().catalog;
  const piece = pieces.find((p) => p.id === pieceId);
  if (!catalog || !piece) return null;
  const s = buildSentence(toData(piece), { catalog, pieces: pieces.map(toData) });
  for (const t of s.tokens) if (t.type === "slot" && !t.spec.optional && (!t.value || t.value.kind === "unsure")) return t.spec.id;
  return null;
}

export const usePlan = create<PlanState>((set, get) => ({
  plan: null,
  pieces: [],
  messages: [],
  analysis: null,
  loading: false,
  error: null,
  saving: 0,
  view: "pieces",
  focusId: null,
  openSlot: null,
  helperOpen: false,
  planSheetOpen: false,
  helperBusy: false,
  justCompleted: null,

  async load(id) {
    set({ loading: true, error: null });
    try {
      if (!useApp.getState().catalog) await useApp.getState().loadCatalog();
      const { plan, pieces, messages } = await api.plans.get(id);
      const focusId = get().plan?.id === id && get().focusId ? get().focusId : (pieces[0]?.id ?? null);
      set({ plan, pieces, messages, analysis: analyze(pieces), loading: false, focusId, view: get().plan?.id === id ? get().view : "pieces", openSlot: null });
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },

  reset() {
    set({ plan: null, pieces: [], messages: [], analysis: null, focusId: null, openSlot: null, view: "pieces", helperOpen: false, planSheetOpen: false, justCompleted: null });
  },

  setView(view) {
    set({ view, openSlot: null });
  },

  focus(id, slot = null) {
    set({ focusId: id, openSlot: slot, view: "pieces", planSheetOpen: false });
  },

  setOpenSlot(openSlot) {
    set({ openSlot });
  },
  setHelperOpen(helperOpen) {
    set({ helperOpen });
  },
  setPlanSheetOpen(planSheetOpen) {
    set({ planSheetOpen });
  },

  setPieces(pieces) {
    set({ pieces, analysis: analyze(pieces) });
  },

  async setSlot(pieceId, slotId, value) {
    const { plan, pieces } = get();
    const catalog = useApp.getState().catalog;
    const piece = pieces.find((p) => p.id === pieceId);
    if (!plan || !piece || !catalog) return;
    const wasComplete = get().analysis?.sentences[pieceId]?.status === "complete";
    // Optimistic: apply locally through the same grammar the server uses.
    const draft = withSlot(toData(piece), slotId, value);
    const { piece: cleaned } = cleanPiece(draft, { catalog, pieces: pieces.map((p) => (p.id === pieceId ? draft : toData(p))) });
    const optimistic = pieces.map((p) => (p.id === pieceId ? { ...p, slots: cleaned.slots } : p));
    get().setPieces(optimistic);
    const next = value && value.kind !== "unsure" ? nextBlank(optimistic, pieceId) : null;
    const nowComplete = get().analysis?.sentences[pieceId]?.status === "complete";
    set({ openSlot: next, justCompleted: !wasComplete && nowComplete ? pieceId : null });
    set((s) => ({ saving: s.saving + 1 }));
    const seq = (slotRequests.get(pieceId) ?? 0) + 1;
    slotRequests.set(pieceId, seq);
    try {
      const res = await api.pieces.update(plan.id, pieceId, { slots: cleaned.slots });
      // Only the newest request for this piece may replace local state.
      if (slotRequests.get(pieceId) === seq) get().setPieces(res.pieces);
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
      await get().load(plan.id);
    } finally {
      set((s) => ({ saving: s.saving - 1 }));
    }
  },

  async addPiece(kind, opts = {}) {
    const { plan } = get();
    if (!plan) return null;
    try {
      const { piece } = await api.pieces.create(plan.id, { kind });
      const pieces = [...get().pieces, piece];
      get().setPieces(pieces);
      if (opts.focus !== false) set({ focusId: piece.id, view: "pieces", openSlot: nextBlank(pieces, piece.id), planSheetOpen: false });
      return piece;
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
      return null;
    }
  },

  async removePiece(id) {
    const { plan, pieces, focusId } = get();
    if (!plan) return;
    const idx = pieces.findIndex((p) => p.id === id);
    try {
      const res = await api.pieces.remove(plan.id, id);
      get().setPieces(res.pieces);
      if (focusId === id) {
        const nextFocus = res.pieces[Math.min(idx, res.pieces.length - 1)]?.id ?? null;
        set({ focusId: nextFocus, openSlot: null });
      }
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    }
  },

  async renamePiece(id, label) {
    const { plan } = get();
    if (!plan) return;
    get().setPieces(get().pieces.map((p) => (p.id === id ? { ...p, label } : p)));
    try {
      await api.pieces.update(plan.id, id, { label });
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    }
  },

  async setNotes(id, notes) {
    const { plan } = get();
    if (!plan) return;
    get().setPieces(get().pieces.map((p) => (p.id === id ? { ...p, notes } : p)));
    try {
      await api.pieces.update(plan.id, id, { notes });
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    }
  },

  async updatePlan(patch) {
    const { plan } = get();
    if (!plan) return;
    set({ plan: { ...plan, ...patch } });
    try {
      const res = await api.plans.update(plan.id, patch);
      set({ plan: { ...get().plan!, ...res.plan } });
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    }
  },

  async addFact(text) {
    const { plan } = get();
    if (!plan || !text.trim()) return;
    await get().updatePlan({ facts: [...plan.facts, text.trim()] });
  },

  async removeFact(index) {
    const { plan } = get();
    if (!plan) return;
    await get().updatePlan({ facts: plan.facts.filter((_, i) => i !== index) });
  },

  async ask(input) {
    const { plan } = get();
    if (!plan || get().helperBusy) return null;
    const shown = input.message?.trim() || (input.intent === "breakdown" ? "Break this into pieces for me." : input.intent === "slot" ? "Help me with this blank." : input.intent === "review" ? "Review the plan." : "");
    const temp: HelperMessage = { id: `temp-${Date.now()}`, role: "user", content: shown, payload: { intent: input.intent, focus: input.focus ?? null }, createdAt: new Date().toISOString() };
    set({ helperBusy: true, messages: [...get().messages, temp], helperOpen: true });
    try {
      const res = await api.helper.ask(plan.id, input);
      const assistant: HelperMessage = {
        id: res.assistantId,
        role: "assistant",
        content: res.message,
        payload: { suggestions: res.suggestions, questions: res.questions, remember: res.remember, source: res.source, model: res.model, notice: res.notice },
        createdAt: new Date().toISOString(),
      };
      set({
        messages: [...get().messages.filter((m) => m.id !== temp.id), { ...temp, id: res.userMessageId }, assistant],
        plan: { ...get().plan!, facts: res.facts },
      });
      return res;
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
      set({ messages: get().messages.filter((m) => m.id !== temp.id) });
      return null;
    } finally {
      set({ helperBusy: false });
    }
  },

  async applySuggestion(s) {
    const { plan } = get();
    if (!plan) return;
    try {
      const res = await api.pieces.apply(plan.id, { pieceId: s.pieceId, kind: s.kind, slots: s.slots });
      get().setPieces(res.pieces);
      set({ focusId: res.pieceId, view: "pieces", openSlot: nextBlank(res.pieces, res.pieceId), planSheetOpen: false });
      if (res.dropped.length) useApp.getState().toast(`Applied. ${res.dropped.length} part${res.dropped.length === 1 ? "" : "s"} didn't fit and were left blank.`);
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    }
  },

  async clearHelper() {
    const { plan } = get();
    if (!plan) return;
    await api.helper.clear(plan.id).catch(() => undefined);
    set({ messages: [] });
  },

  async writeBrief() {
    const { plan } = get();
    if (!plan) return;
    set({ helperBusy: true });
    try {
      const res = await api.plans.brief(plan.id);
      set({ plan: { ...get().plan!, brief: res.brief } });
      if (res.source === "rules") useApp.getState().toast("No AI model is configured, so this brief was assembled from the plan itself.");
    } catch (e) {
      useApp.getState().toast(errorMessage(e), "danger");
    } finally {
      set({ helperBusy: false });
    }
  },
}));
