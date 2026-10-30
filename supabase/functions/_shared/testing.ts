import { type Config, loadConfig } from "./config.ts";
import type { ChatJson, ChatJsonRequest } from "./nemotron.ts";
import type { Simulator } from "./simulator.ts";
import { MemoryStore } from "./store.ts";
import type { ParameterSpace, Params, SimRun } from "./types.ts";
import type { Deps } from "./workflow.ts";

export function testConfig(overrides: Record<string, string> = {}): Config {
  const env = new Map(Object.entries({ NEBIUS_API_KEY: "test-key", SIMULATOR_URL: "http://sim.test", ...overrides }));
  return loadConfig({ get: (k) => env.get(k) });
}

export const MINI_SPACE: ParameterSpace = {
  family: "forklift_crossing",
  units: "1 unit = 1 cm",
  world: { width: 800, height: 600 },
  fixed: { robot_radius: 15 },
  parameters: {
    forklift_speed: { type: "number", min: 40, max: 200, default: 120, description: "speed" },
    forklift_start_time: { type: "number", min: 0, max: 8, default: 2.3, description: "start" },
    forklift_direction: { type: "enum", values: ["southbound", "northbound"], default: "southbound", description: "dir" },
  },
  seed: { type: "integer", min: 0, max: 2 ** 31 - 1 },
};

export class FakeSimulator implements Simulator {
  calls: { params: Params; seed: number; scenario_id: string }[] = [];
  parameterSpace() {
    return Promise.resolve(MINI_SPACE);
  }
  validate(items: Params[]) {
    return Promise.resolve(items.map((p) => {
      const errors: string[] = [];
      const full: Params = { forklift_speed: 120, forklift_start_time: 2.3, forklift_direction: "southbound" };
      for (const [k, v] of Object.entries(p)) {
        const spec = MINI_SPACE.parameters[k];
        if (!spec) errors.push(`unsupported parameter: '${k}'`);
        else if (spec.type === "number" && (typeof v !== "number" || v < spec.min! || v > spec.max!)) errors.push(`${k} out of range`);
        else full[k] = v;
      }
      return errors.length ? { valid: false, params: null, errors } : { valid: true, params: full, errors: [] };
    }));
  }
  simulate(item: { params: Params; seed: number; scenario_id: string }): Promise<SimRun> {
    this.calls.push(item);
    const start = Number(item.params.forklift_start_time);
    const hit = start >= 2 && start <= 3;
    const trajectory = [{ t: 0, x: 55, y: 305, heading: 0, status: "start" }, { t: 4.35, x: 403, y: 305, heading: 0, status: "moving" }];
    return Promise.resolve({
      params: item.params,
      seed: item.seed,
      scenario: { id: item.scenario_id },
      outcome: hit ? "collision" : "success",
      reason: hit ? "moving obstacle 'forklift' hit the robot at t=4.35s" : "reached goal at t=8.55s",
      failure_mode: hit ? "collision:moving:side" : null,
      metrics: { distance_travelled: 348, min_clearance: hit ? -6 : 40, goal_progress: hit ? 0.5 : 0.99, path_efficiency: hit ? null : 1 },
      collision: hit ? { t: 4.35, step: 87, x: 403, y: 305, obstacle_id: "forklift" } : null,
      duration: hit ? 4.35 : 8.55,
      steps: hit ? 87 : 171,
      replay: {
        schema_version: 1,
        scenario: { id: item.scenario_id },
        result: { trajectory },
        moving_obstacle_tracks: [{ id: "forklift", samples: [{ t: 0, x: 400, y: 30 }, { t: 4.35, x: 400, y: 276 }] }],
      },
    });
  }
  randomParams(count: number, seed: number) {
    let s = seed;
    const next = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    return Promise.resolve(Array.from({ length: count }, () => ({
      params: { forklift_speed: 40 + next() * 160, forklift_start_time: next() * 8, forklift_direction: next() < 0.5 ? "southbound" : "northbound" },
      seed: Math.floor(next() * 1e6),
    })));
  }
}

export const VALID_ANALYSIS = {
  observed_facts: [{ statement: "S1 ended in a collision with the forklift at t=4.35 s.", result_refs: ["S1"] }],
  failure_hypothesis: "The reactive controller does not predict the forklift's motion.",
  confidence: "medium",
  evidence: [{ statement: "The robot kept moving (no wait steps) until impact.", result_refs: ["S1"] }],
  recommendations: ["Vary the forklift start time around the robot's arrival."],
  recommended_next_experiment: "Shift forklift_start_time by +/- 0.5 s.",
  limitations: ["Simplified 2D kinematic simulator."],
};

export function proposals(times: number[]) {
  return {
    proposed_scenarios: times.map((t, i) => ({
      name: `Crossing at ${t}s #${i}`,
      hypothesis: "Timing of the crossing determines the collision.",
      prediction: t >= 2 && t <= 3 ? "collision expected" : "success expected",
      rationale: "probe timing",
      parameters: { forklift_speed: null, forklift_start_time: t, forklift_direction: null },
    })),
  };
}

export class FakeLlm {
  requests: ChatJsonRequest[] = [];
  analysis: () => unknown = () => VALID_ANALYSIS;
  private batch = 0;
  proposals: (count: number) => unknown = () => {
    this.batch++;
    return proposals([2.1 + this.batch * 0.01, 2.5 + this.batch * 0.01, 6 + this.batch * 0.01]);
  };
  fn: ChatJson = (req) => {
    this.requests.push(req);
    const data = req.schemaName === "failure_analysis" ? this.analysis() : this.proposals(0);
    return Promise.resolve({ data, model: "nvidia/Nemotron-3_5-Lightning", usage: { total_tokens: 10 } });
  };
}

export function makeDeps(opts: { config?: Config; sim?: Simulator; llm?: FakeLlm } = {}) {
  const llm = opts.llm ?? new FakeLlm();
  const sim = (opts.sim ?? new FakeSimulator()) as FakeSimulator;
  const store = new MemoryStore();
  const deps: Deps = { config: opts.config ?? testConfig(), store, llm: llm.fn, sim };
  return { deps, store, llm, sim };
}
