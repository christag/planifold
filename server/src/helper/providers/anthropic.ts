import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { HelperError, type ChatMessage, type LlmProvider } from "./types.js";

export function anthropicProvider(opts: { apiKey: string; model: string; baseURL?: string | null; label: string }): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL || undefined, maxRetries: 2, timeout: 180_000 });
  const model = opts.model;

  const wrap = (e: unknown): never => {
    if (e instanceof Anthropic.AuthenticationError) throw new HelperError("Anthropic rejected the API key. Check it in Admin → AI.");
    if (e instanceof Anthropic.RateLimitError) throw new HelperError("Anthropic is rate limiting requests. Try again in a moment.", true);
    if (e instanceof Anthropic.NotFoundError) throw new HelperError(`Anthropic doesn't know the model “${model}”. Check the model id in Admin → AI.`);
    if (e instanceof Anthropic.APIConnectionError) throw new HelperError("Couldn't reach Anthropic. Check the base URL and the network path from this server.", true);
    if (e instanceof Anthropic.APIError) throw new HelperError(`Anthropic returned an error (${e.status}): ${e.message}`, (e.status ?? 500) >= 500);
    if (e instanceof Error) throw new HelperError(`The model's answer couldn't be used: ${e.message}`, true);
    throw e;
  };

  return {
    label: opts.label,
    async structured<T>(schema: z.ZodType<T>, system: string, messages: ChatMessage[]): Promise<T> {
      try {
        const res = await client.messages.parse({
          model,
          max_tokens: 8000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages,
          output_config: { format: zodOutputFormat(schema) },
        });
        if (res.stop_reason === "refusal") throw new HelperError("The model declined to answer that.");
        if (res.stop_reason === "max_tokens") throw new HelperError("The answer was cut off. Try a narrower question.", true);
        if (!res.parsed_output) throw new HelperError("The model returned something the helper couldn't read. Try again.", true);
        return res.parsed_output as T;
      } catch (e) {
        if (e instanceof HelperError) throw e;
        return wrap(e);
      }
    },
    async text(system: string, messages: ChatMessage[]): Promise<string> {
      try {
        const res = await client.messages.create({ model, max_tokens: 8000, system, messages });
        if (res.stop_reason === "refusal") throw new HelperError("The model declined to answer that.");
        return res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
      } catch (e) {
        if (e instanceof HelperError) throw e;
        return wrap(e);
      }
    },
    async test() {
      try {
        const res = await client.messages.create({ model, max_tokens: 20, messages: [{ role: "user", content: "Reply with the single word OK." }] });
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return { ok: true, message: `Connected. ${res.model} replied: ${text.trim().slice(0, 40)}` };
      } catch (e) {
        try {
          wrap(e);
        } catch (h) {
          return { ok: false, message: (h as Error).message };
        }
        return { ok: false, message: (e as Error).message };
      }
    },
  };
}
