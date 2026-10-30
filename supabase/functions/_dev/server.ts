import { loadConfig } from "../_shared/config.ts";
import { handlers } from "../_shared/handlers.ts";
import { makeNemotron } from "../_shared/nemotron.ts";
import { makeSimulator } from "../_shared/simulator.ts";
import { MemoryStore } from "../_shared/store.ts";

const dotenv = new Map<string, string>();
try {
  for (const line of (await Deno.readTextFile(new URL("../../../.env", import.meta.url))).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) dotenv.set(line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, ""));
  }
} catch { }

const config = loadConfig({ get: (k) => Deno.env.get(k) ?? dotenv.get(k) ?? ({ SIMULATOR_URL: "http://127.0.0.1:8787" } as Record<string, string>)[k] });
const deps = { config, store: new MemoryStore(), llm: makeNemotron(config.nebius), sim: makeSimulator(config.simulator) };
const port = Number(Deno.env.get("DEV_PORT") ?? 54399);

console.log(`WorldForge dev functions on http://127.0.0.1:${port}/functions/v1/<name>`);
console.log(`  model=${config.nebius.model} key=${config.nebius.apiKey ? "set" : "MISSING"} simulator=${config.simulator.url}`);
console.log("  store=in-memory (not persisted)");

Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
  const name = new URL(req.url).pathname.match(/^\/functions\/v1\/([a-z-]+)\/?$/)?.[1];
  const handler = name ? handlers[name] : undefined;
  if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const started = performance.now();
  return handler(req, deps).then((res) => {
    console.log(`${req.method} ${name} -> ${res.status} (${Math.round(performance.now() - started)} ms)`);
    return res;
  });
});
