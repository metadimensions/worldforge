import type { Config } from "./config.ts";
import type { ParameterSpace, Params, SimRun } from "./types.ts";

export class SimulatorError extends Error {
  constructor(message: string, public details: string[] = [], public status = 0) {
    super(message);
    this.name = "SimulatorError";
  }
}

export interface Simulator {
  parameterSpace(): Promise<ParameterSpace>;
  validate(items: Params[]): Promise<{ valid: boolean; params: Params | null; errors: string[] }[]>;
  simulate(item: { params: Params; seed: number; scenario_id: string }): Promise<SimRun>;
  randomParams(count: number, seed: number): Promise<{ params: Params; seed: number }[]>;
}

export function makeSimulator(cfg: Config["simulator"], fetchImpl: typeof fetch = fetch): Simulator {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!cfg.url) throw new SimulatorError("SIMULATOR_URL is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new SimulatorError(payload?.error ?? `simulator returned HTTP ${res.status}`, payload?.details ?? [], res.status);
      }
      return payload as T;
    } catch (e) {
      if (e instanceof SimulatorError) throw e;
      if (controller.signal.aborted) throw new SimulatorError(`simulator did not respond within ${cfg.timeoutMs} ms`);
      throw new SimulatorError(`simulator request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  let spaceCache: ParameterSpace | null = null;
  return {
    async parameterSpace() {
      spaceCache ??= await call<ParameterSpace>("GET", "/parameter-space");
      return spaceCache;
    },
    async validate(items) {
      const r = await call<{ results: { valid: boolean; params: Params | null; errors: string[] }[] }>("POST", "/validate", {
        items: items.map((params) => ({ params })),
      });
      return r.results;
    },
    simulate: (item) => call<SimRun>("POST", "/simulate", item),
    async randomParams(count, seed) {
      const r = await call<{ items: { params: Params; seed: number }[] }>("POST", "/random-params", { count, seed });
      return r.items;
    },
  };
}
