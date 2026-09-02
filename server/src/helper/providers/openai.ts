import OpenAI from "openai";
import { zodResponseFormat, zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { HelperError, type ChatMessage, type LlmProvider } from "./types.js";

/**
 * Two flavours share this file:
 * - "openai": the Responses API, for OpenAI itself.
 * - "openai_compatible": Chat Completions with a JSON schema response format,
 *   for gateways and self-hosted servers that speak the OpenAI wire format.
 */
export function openaiProvider(opts: { kind: "openai" | "openai_compatible"; apiKey: string | null; model: string; baseURL?: string | null; label: string }): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey || "not-needed", baseURL: opts.baseURL || undefined, maxRetries: 2, timeout: 180_000 });
  const model = opts.model;
  const compat = opts.kind === "openai_compatible";
  const who = compat ? "The model server" : "OpenAI";

  const wrap = (e: unknown): never => {
    if (e instanceof OpenAI.AuthenticationError) throw new HelperError(`${who} rejected the API key. Check it in Admin → AI.`);
    if (e instanceof OpenAI.RateLimitError) throw new HelperError(`${who} is rate limiting requests. Try again in a moment.`, true);
    if (e instanceof OpenAI.NotFoundError) throw new HelperError(`${who} doesn't know the model “${model}”. Check the model id in Admin → AI.`);
    if (e instanceof OpenAI.APIConnectionError) throw new HelperError(`Couldn't reach ${who.toLowerCase() === "openai" ? "OpenAI" : "the model server"}. Check the base URL and the network path from this server.`, true);
    if (e instanceof OpenAI.APIError) throw new HelperError(`${who} returned an error (${e.status}): ${e.message}`, (e.status ?? 500) >= 500);
    if (e instanceof Error) throw new HelperError(`The model's answer couldn't be used: ${e.message}`, true);
    throw e;
  };

  return {
    label: opts.label,
    async structured<T>(schema: z.ZodType<T>, system: string, messages: ChatMessage[]): Promise<T> {
      try {
        if (compat) {
          const completion = await client.chat.completions.parse({
            model,
            messages: [{ role: "system", content: system }, ...messages],
            response_format: zodResponseFormat(schema, "helper_response"),
          });
          const choice = completion.choices[0];
          if (choice?.message.refusal) throw new HelperError("The model declined to answer that.");
          if (choice?.finish_reason === "length") throw new HelperError("The answer was cut off. Try a narrower question.", true);
          if (!choice?.message.parsed) throw new HelperError("The model returned something the helper couldn't read. Try again.", true);
          return choice.message.parsed as T;
        }
        const res = await client.responses.parse({
          model,
          input: [{ role: "system", content: system }, ...messages],
          text: { format: zodTextFormat(schema, "helper_response") },
        });
        if (res.status === "incomplete")
          throw new HelperError(res.incomplete_details?.reason === "max_output_tokens" ? "The answer was cut off. Try a narrower question." : "The model stopped before finishing. Try again.", true);
        const refused = res.output.some((o) => o.type === "message" && o.content.some((c) => c.type === "refusal"));
        if (refused) throw new HelperError("The model declined to answer that.");
        if (!res.output_parsed) throw new HelperError("The model returned something the helper couldn't read. Try again.", true);
        return res.output_parsed as T;
      } catch (e) {
        if (e instanceof HelperError) throw e;
        return wrap(e);
      }
    },
    async text(system: string, messages: ChatMessage[]): Promise<string> {
      try {
        if (compat) {
          const completion = await client.chat.completions.create({ model, messages: [{ role: "system", content: system }, ...messages] });
          return (completion.choices[0]?.message.content ?? "").trim();
        }
        const res = await client.responses.create({ model, input: [{ role: "system", content: system }, ...messages] });
        return res.output_text.trim();
      } catch (e) {
        if (e instanceof HelperError) throw e;
        return wrap(e);
      }
    },
    async test() {
      try {
        const text = compat
          ? ((await client.chat.completions.create({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_completion_tokens: 20 })).choices[0]?.message.content ?? "")
          : (await client.responses.create({ model, input: "Reply with the single word OK.", max_output_tokens: 20 })).output_text;
        return { ok: true, message: `Connected. ${model} replied: ${text.trim().slice(0, 40)}` };
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
