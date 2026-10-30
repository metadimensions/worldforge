export interface Config {
  nebius: {
    apiKey: string | undefined;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
    responseFormat: "json_object" | "json_schema";
  };
  simulator: { url: string | undefined; token: string | undefined; timeoutMs: number };
  limits: {
    maxIterations: number;
    scenariosPerIteration: number;
    maxTotalSimulations: number;
    maxRunningExperiments: number;
    maxExperimentsPerDay: number;
    lockMs: number;
  };
  accessCode: string | undefined;
  allowedOrigin: string;
}

type Env = { get(name: string): string | undefined };

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env.get(name);
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

export function loadConfig(env: Env = Deno.env): Config {
  return {
    nebius: {
      apiKey: env.get("NEBIUS_API_KEY") || undefined,
      baseUrl: (env.get("NEBIUS_BASE_URL") || "https://api.tokenfactory.nebius.com/v1").replace(/\/$/, ""),
      model: env.get("NEBIUS_MODEL") || "nvidia/Nemotron-3_5-Lightning",
      timeoutMs: int(env, "NEBIUS_TIMEOUT_MS", 110_000, 1_000, 140_000),
      maxTokens: int(env, "NEBIUS_MAX_TOKENS", 8_000, 256, 32_000),
      responseFormat: env.get("NEBIUS_RESPONSE_FORMAT") === "json_schema" ? "json_schema" : "json_object",
    },
    simulator: {
      url: (env.get("SIMULATOR_URL") || "").replace(/\/$/, "") || undefined,
      token: env.get("SIMULATOR_TOKEN") || undefined,
      timeoutMs: int(env, "SIMULATOR_TIMEOUT_MS", 20_000, 1_000, 60_000),
    },
    limits: {
      maxIterations: int(env, "MAX_ITERATIONS", 3, 1, 10),
      scenariosPerIteration: int(env, "SCENARIOS_PER_ITERATION", 3, 1, 10),
      maxTotalSimulations: int(env, "MAX_TOTAL_SIMULATIONS", 10, 2, 50),
      maxRunningExperiments: int(env, "MAX_RUNNING_EXPERIMENTS", 3, 1, 100),
      maxExperimentsPerDay: int(env, "MAX_EXPERIMENTS_PER_DAY", 20, 1, 10_000),
      lockMs: int(env, "STEP_LOCK_MS", 150_000, 10_000, 600_000),
    },
    accessCode: env.get("WORLDFORGE_ACCESS_CODE") || undefined,
    allowedOrigin: env.get("ALLOWED_ORIGIN") || "*",
  };
}

export function modelCallCap(maxIterations: number): number {
  return 2 * maxIterations + 1 + 3;
}
