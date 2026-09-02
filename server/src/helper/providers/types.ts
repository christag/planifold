import type { z } from "zod";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  readonly label: string;
  structured<T>(schema: z.ZodType<T>, system: string, messages: ChatMessage[]): Promise<T>;
  text(system: string, messages: ChatMessage[]): Promise<string>;
  test(): Promise<{ ok: boolean; message: string }>;
}

export class HelperError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
