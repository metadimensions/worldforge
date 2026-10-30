import { type Config, loadConfig } from "./config.ts";
import { makeNemotron, NemotronError } from "./nemotron.ts";
import { makeSimulator, SimulatorError } from "./simulator.ts";
import { SupabaseStore } from "./store.ts";
import {
  advanceExperiment,
  analyzeSimulationStandalone,
  type Deps,
  experimentView,
  generateScenariosStandalone,
  simulationReplay,
  startExperiment,
  stopExperiment,
  WorkflowError,
} from "./workflow.ts";
import { compareTesting } from "./comparison.ts";

export type Handler = (req: Request, deps: Deps) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(config: Config): HeadersInit {
  return {
    "Access-Control-Allow-Origin": config.allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worldforge-access-code",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

export function json(config: Config, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(config) } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new WorkflowError(413, "request body too large");
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkflowError(400, "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new WorkflowError(400, "request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function experimentId(b: Record<string, unknown>): string {
  const id = b.experiment_id;
  if (typeof id !== "string" || !UUID.test(id)) throw new WorkflowError(400, "experiment_id must be a UUID");
  return id;
}

function requireAccess(req: Request, config: Config) {
  if (config.accessCode && req.headers.get("x-worldforge-access-code") !== config.accessCode) {
    throw new WorkflowError(401, "a valid WorldForge access code is required");
  }
}

function wrap(fn: (req: Request, b: Record<string, unknown>, deps: Deps) => Promise<unknown>): Handler {
  return async (req, deps) => {
    const config = deps.config;
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors(config) });
    if (req.method !== "POST") return json(config, 405, { error: "use POST" });
    try {
      return json(config, 200, await fn(req, await body(req), deps));
    } catch (e) {
      if (e instanceof WorkflowError) return json(config, e.status, { error: e.message, details: e.details });
      if (e instanceof NemotronError) return json(config, e.code === "missing_key" ? 500 : 502, { error: e.message, code: e.code });
      if (e instanceof SimulatorError) {
        return json(config, e.status === 400 ? 400 : 502, { error: `simulator: ${e.message}`, details: e.details });
      }
      console.error("unhandled error:", (e as Error)?.name, (e as Error)?.message);
      return json(config, 500, { error: "internal error" });
    }
  };
}

export const handlers: Record<string, Handler> = {
  "start-experiment": wrap(async (req, b, deps) => {
    requireAccess(req, deps.config);
    const exp = await startExperiment(deps, b);
    await advanceExperiment(deps, exp.id);
    return experimentView(deps, exp.id);
  }),

  "advance-experiment": wrap(async (_req, b, deps) => {
    const id = experimentId(b);
    const { step } = await advanceExperiment(deps, id);
    return { step, ...(await experimentView(deps, id)) };
  }),

  "get-experiment": wrap(async (_req, b, deps) => {
    const id = experimentId(b);
    if (b.result_id !== undefined) {
      if (typeof b.result_id !== "string" || !UUID.test(b.result_id)) throw new WorkflowError(400, "result_id must be a UUID");
      return { replay: await simulationReplay(deps, id, b.result_id) };
    }
    return experimentView(deps, id);
  }),

  "stop-experiment": wrap(async (_req, b, deps) => {
    const id = experimentId(b);
    await stopExperiment(deps, id);
    return experimentView(deps, id);
  }),

  "analyze-simulation": wrap(async (req, b, deps) => {
    requireAccess(req, deps.config);
    return { analysis: await analyzeSimulationStandalone(deps, experimentId(b), b.simulation_result_ids) };
  }),

  "generate-scenarios": wrap(async (req, b, deps) => {
    requireAccess(req, deps.config);
    return generateScenariosStandalone(deps, experimentId(b));
  }),

  "compare-testing": wrap(async (_req, b, deps) => {
    const id = experimentId(b);
    const view = await experimentView(deps, id);
    return { experiment_id: id, status: view.experiment.status, comparison: compareTesting(view.simulations) };
  }),
};

export function productionDeps(): Deps {
  const config = loadConfig();
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available");
  return {
    config,
    store: new SupabaseStore(url, serviceKey),
    llm: makeNemotron(config.nebius),
    sim: makeSimulator(config.simulator),
  };
}

export function serve(name: keyof typeof handlers) {
  let deps: Deps | null = null;
  Deno.serve((req) => {
    deps ??= productionDeps();
    return handlers[name](req, deps);
  });
}
