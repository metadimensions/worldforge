import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";

import { extractJson, makeNemotron, NemotronError } from "./nemotron.ts";
import { testConfig } from "./testing.ts";

const REQ = { system: "s", user: "u", schemaName: "failure_analysis", schema: { type: "object" } };

function reply(content: string | null, finish = "stop", status = 200) {
  return new Response(JSON.stringify({ model: "nvidia/Nemotron-3_5-Lightning", usage: { total_tokens: 5 }, choices: [{ finish_reason: finish, message: { content } }] }), {
    status,
  });
}

Deno.test("successful Nemotron request uses structured output and parses JSON", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const llm = makeNemotron(testConfig().nebius, (url, init) => {
    seen = { url: String(url), init: init! };
    return Promise.resolve(reply('```json\n{"ok": true}\n```'));
  });
  const res = await llm(REQ);
  assertEquals(res.data, { ok: true });
  assertEquals(res.model, "nvidia/Nemotron-3_5-Lightning");
  assert(seen!.url.endsWith("/chat/completions"));
  const sent = JSON.parse(String(seen!.init.body));
  assertEquals(sent.model, "nvidia/Nemotron-3_5-Lightning");
  assertEquals(sent.response_format.type, "json_object");
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, "Bearer test-key");

  const strict = makeNemotron(testConfig({ NEBIUS_RESPONSE_FORMAT: "json_schema" }).nebius, (url, init) => {
    seen = { url: String(url), init: init! };
    return Promise.resolve(reply('{"ok": 1}'));
  });
  await strict(REQ);
  const strictBody = JSON.parse(String(seen!.init.body));
  assertEquals(strictBody.response_format.json_schema.name, "failure_analysis");
});

Deno.test("missing Token Factory key fails before any request", async () => {
  let called = false;
  const llm = makeNemotron(testConfig({ NEBIUS_API_KEY: "" }).nebius, () => {
    called = true;
    return Promise.resolve(reply("{}"));
  });
  const err = await assertRejects(() => llm(REQ), NemotronError);
  assertEquals(err.code, "missing_key");
  assert(!called);
});

Deno.test("provider timeout is reported as a timeout", async () => {
  const cfg = { ...testConfig().nebius, timeoutMs: 20 };
  const llm = makeNemotron(cfg, (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
  const err = await assertRejects(() => llm(REQ), NemotronError);
  assertEquals(err.code, "timeout");
});

Deno.test("invalid model responses are rejected", async () => {
  for (const [res, why] of [
    [reply("not json at all"), "non-JSON content"],
    [reply(null, "length"), "out of tokens"],
    [new Response("<html>", { status: 200 }), "non-JSON body"],
  ] as const) {
    const llm = makeNemotron(testConfig().nebius, () => Promise.resolve(res.clone()));
    const err = await assertRejects(() => llm(REQ), NemotronError, undefined, why);
    assertEquals(err.code, "invalid_response");
  }
});

Deno.test("transient provider errors are retried once, then reported", async () => {
  let calls = 0;
  const llm = makeNemotron(testConfig().nebius, () => {
    calls++;
    return Promise.resolve(new Response("busy", { status: 503 }));
  });
  const err = await assertRejects(() => llm(REQ), NemotronError);
  assertEquals([err.code, calls], ["provider_error", 2]);

  calls = 0;
  const flaky = makeNemotron(testConfig().nebius, () => Promise.resolve(++calls === 1 ? new Response("", { status: 429 }) : reply('{"a":1}')));
  assertEquals((await flaky(REQ)).data, { a: 1 });
});

Deno.test("the API key never appears in error messages", async () => {
  const llm = makeNemotron(testConfig().nebius, () => Promise.resolve(new Response("bad key test-key", { status: 401 })));
  const err = await assertRejects(() => llm(REQ), NemotronError);
  assert(!err.message.includes("test-key"), err.message);
});

Deno.test("extractJson strips think tags and surrounding text", () => {
  assertEquals(extractJson('<think>hmm {"x":0}</think>Here: {"x": 2} done'), { x: 2 });
});
