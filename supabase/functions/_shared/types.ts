export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Params = Record<string, number | string>;

export type Arm = "baseline" | "ai" | "random";
export type Outcome = "success" | "collision" | "timeout" | "no_path" | "stuck";
export type ExperimentStatus = "running" | "stopped" | "completed" | "failed";
export type Phase = "baseline" | "analyze" | "generate" | "execute" | "random" | "compare" | "done";

export interface ParamSpec {
  type: "number" | "enum";
  min?: number;
  max?: number;
  values?: string[];
  default: number | string;
  unit?: string;
  description: string;
}

export interface ParameterSpace {
  family: string;
  units: string;
  world: Record<string, Json>;
  fixed: Record<string, Json>;
  parameters: Record<string, ParamSpec>;
  seed: { type: "integer"; min: number; max: number };
}

export interface SimRun {
  params: Params;
  seed: number;
  scenario: Record<string, Json>;
  outcome: Outcome;
  reason: string;
  failure_mode: string | null;
  metrics: Record<string, number | null>;
  collision: { t: number; step: number; x: number; y: number; obstacle_id: string } | null;
  duration: number;
  steps: number;
  replay: {
    schema_version: number;
    scenario: Record<string, Json>;
    result: { trajectory: { t: number; x: number; y: number; heading: number; status: string }[] } & Record<string, Json>;
    moving_obstacle_tracks: { id: string; samples: { t: number; x: number; y: number }[] }[];
  };
}

export interface Experiment {
  id: string;
  status: ExperimentStatus;
  phase: Phase;
  created_at: string;
  updated_at: string;
  model_id: string;
  initial_scenario: Params;
  simulation_budget: number;
  max_iterations: number;
  scenarios_per_iteration: number;
  base_seed: number;
  completed_simulations: number;
  model_calls: number;
  current_iteration: number;
  error: string | null;
  error_count: number;
  lock_until: string | null;
  comparison: Json | null;
}

export interface SimulationRow {
  id: string;
  experiment_id: string;
  seq: number;
  arm: Arm;
  iteration: number;
  proposal_index: number | null;
  name: string | null;
  hypothesis: string | null;
  scenario_id: string;
  seed: number;
  params: Params;
  scenario_config: Record<string, Json>;
  outcome: Outcome;
  failure_type: string | null;
  reason: string;
  metrics: Record<string, number | null>;
  collision: SimRun["collision"];
  trajectory: SimRun["replay"]["result"]["trajectory"];
  replay: SimRun["replay"];
  created_at: string;
}

export interface EvidenceItem {
  statement: string;
  result_refs: string[];
}

export interface Proposal {
  name: string;
  hypothesis: string;
  prediction: string;
  predicted_outcome?: Outcome | null;
  rationale: string;
  overrides: Params;
  params: Params;
  seed: number;
}

export interface AnalysisRow {
  id: string;
  experiment_id: string;
  kind: "analysis" | "proposal";
  iteration: number;
  simulation_result_ids: string[];
  failure_hypothesis: string | null;
  confidence: "low" | "medium" | "high" | null;
  observed_facts: EvidenceItem[] | null;
  evidence: EvidenceItem[] | null;
  recommendations: string[] | null;
  recommended_next_experiment: string | null;
  limitations: string[] | null;
  proposed_scenarios: Proposal[] | null;
  rejected_proposals: { proposal: Json; errors: string[] }[] | null;
  model_id: string;
  usage: Json | null;
  created_at: string;
}
