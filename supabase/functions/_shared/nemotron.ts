import type { Config } from "./config.ts";
import type { Json } from "./types.ts";

export type NemotronErrorCode = "missing_key" | "timeout" | "provider_error" | "invalid_response";

export class NemotronError extends Error {
  constructor(public code: NemotronErrorCode, message: string) {
    super(message);
    this.name = "NemotronError";
  }
}

export interface ChatJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Json;
  plain?: boolean;
}

export interface ChatJsonResult {
  data: unknown;
  model: string;
  usage: Json | null;
}

export type ChatJson = (req: ChatJsonRequest) => Promise<ChatJsonResult>;

export function extractJson(content: string): unknown {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  return JSON.parse(text);
}

export function makeNemotron(cfg: Config["nebius"], fetchImpl: typeof fetch = fetch): ChatJson {
  return async (req) => {
    if (!cfg.apiKey) throw new NemotronError("missing_key", "NEBIUS_API_KEY is not configured");

    const body = {
      model: cfg.model,
      temperature: 0.3,
      max_tokens: cfg.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...(req.plain ? {} : {
        response_format: cfg.responseFormat === "json_schema"
          ? { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } }
          : { type: "json_object" },
      }),
    };

    let lastError: NemotronError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (controller.signal.aborted) throw new NemotronError("timeout", `Token Factory did not respond within ${cfg.timeoutMs} ms`);
        throw new NemotronError("provider_error", `Token Factory request failed: ${(e as Error).name}`);
      }
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastError = new NemotronError("provider_error", `Token Factory returned HTTP ${res.status}`);
        await res.body?.cancel();
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300).replaceAll(cfg.apiKey, "[redacted]");
        throw new NemotronError("provider_error", `Token Factory returned HTTP ${res.status}: ${detail}`);
      }

      let payload: { model?: string; usage?: Json; choices?: { finish_reason?: string; message?: { content?: string | null } }[] };
      try {
        payload = await res.json();
      } catch {
        throw new NemotronError("invalid_response", "Token Factory returned a non-JSON body");
      }
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        const why = choice?.finish_reason === "length" ? " (ran out of tokens while reasoning)" : "";
        throw new NemotronError("invalid_response", `model returned no content${why}`);
      }
      let data: unknown;
      try {
        data = extractJson(content);
      } catch {
        throw new NemotronError("invalid_response", "model output is not valid JSON");
      }
      if (choice?.finish_reason === "length") {
        throw new NemotronError("invalid_response", "model output was cut off (ran out of tokens while reasoning)");
      }
      if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) {
        throw new NemotronError("invalid_response", "model returned an empty JSON object");
      }
      return { data, model: payload.model ?? cfg.model, usage: payload.usage ?? null };
    }
    throw lastError ?? new NemotronError("provider_error", "Token Factory request failed");
  };
}
