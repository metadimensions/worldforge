import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";

import type { Replay } from "./replay";

export type Params = Record<string, number | string>;

export interface EvidenceItem {
  statement: string;
  result_refs: string[];
}

export interface Proposal {
  name: string;
  hypothesis: string;
  prediction: string;
  rationale: string;
  overrides: Params;
  params: Params;
  seed: number;
}

export interface Analysis {
  id: string;
  kind: "analysis" | "proposal";
  iteration: number;
  failure_hypothesis: string | null;
  confidence: "low" | "medium" | "high" | null;
  observed_facts: EvidenceItem[] | null;
  evidence: EvidenceItem[] | null;
  recommendations: string[] | null;
  recommended_next_experiment: string | null;
  limitations: string[] | null;
  proposed_scenarios: Proposal[] | null;
  rejected_proposals: { proposal: unknown; errors: string[] }[] | null;
  model_id: string;
  created_at: string;
}

export interface SimulationSummary {
  id: string;
  seq: number;
  arm: "baseline" | "ai" | "random";
  iteration: number;
  proposal_index: number | null;
  name: string | null;
  hypothesis: string | null;
  seed: number;
  params: Params;
  outcome: string;
  failure_type: string | null;
  reason: string;
  metrics: Record<string, number | null>;
}

export interface ArmStats {
  total_simulations: number;
  outcomes: Record<string, number>;
  failures: number;
  failure_discovery_rate: number | null;
  unique_failure_modes: string[];
  new_failure_modes: string[];
  first_failure_at: number | null;
  seeds: number[];
}

export interface Comparison {
  baseline: { outcome: string; failure_type: string | null } | null;
  simulations_per_arm: { ai: number; random: number };
  equal_budget: boolean;
  arms: { ai: ArmStats; random: ArmStats };
  summary: string;
}

export interface ExperimentView {
  step?: string;
  experiment: {
    id: string;
    status: "running" | "stopped" | "completed" | "failed";
    phase: string;
    model_id: string;
    initial_scenario: Params;
    simulation_budget: number;
    max_iterations: number;
    current_iteration: number;
    completed_simulations: number;
    base_seed: number;
    error: string | null;
    created_at: string;
  };
  progress: {
    phase: string;
    iteration: number;
    max_iterations: number;
    ai_simulations: number;
    random_simulations: number;
    simulation_budget_per_arm: number;
    model_calls: number;
    model_call_cap: number;
  };
  simulations: SimulationSummary[];
  analyses: Analysis[];
  comparison: Comparison;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public details: string[] = []) {
    super(message);
  }
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;
export const aiConfigured = Boolean(URL_ && ANON);

function supabase(): SupabaseClient {
  if (!URL_ || !ANON) throw new ApiError("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)", 0);
  client ??= createClient(URL_, ANON, { auth: { persistSession: false } });
  return client;
}

async function invoke<T>(name: string, body: Record<string, unknown>, accessCode?: string): Promise<T> {
  const { data, error } = await supabase().functions.invoke(name, {
    body,
    headers: accessCode ? { "x-worldforge-access-code": accessCode } : undefined,
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      const payload = await res.json().catch(() => ({}));
      throw new ApiError(payload.error ?? `request failed (${res.status})`, res.status, payload.details ?? []);
    }
    throw new ApiError(error.message ?? "network error", 0);
  }
  return data as T;
}

export const api = {
  start: (initialParams: Params, accessCode?: string) => invoke<ExperimentView>("start-experiment", { initial_params: initialParams }, accessCode),
  advance: (id: string) => invoke<ExperimentView>("advance-experiment", { experiment_id: id }),
  get: (id: string) => invoke<ExperimentView>("get-experiment", { experiment_id: id }),
  stop: (id: string) => invoke<ExperimentView>("stop-experiment", { experiment_id: id }),
  replay: async (id: string, resultId: string) => (await invoke<{ replay: Replay }>("get-experiment", { experiment_id: id, result_id: resultId })).replay,
};

export const ref = (s: Pick<SimulationSummary, "seq">) => `S${s.seq}`;

export const PHASE_LABELS: Record<string, string> = {
  baseline: "Running baseline simulation",
  analyze: "Nemotron is analysing the results",
  generate: "Nemotron is designing targeted scenarios",
  execute: "Simulating AI-proposed scenarios",
  random: "Running random-testing baseline",
  compare: "Comparing AI-guided vs random testing",
  done: "Done",
};
