import type { Json, SimulationRow } from "./types.ts";

const OUTCOMES = ["success", "collision", "no_path", "timeout", "stuck"] as const;

export interface ArmStats {
  total_simulations: number;
  outcomes: Record<(typeof OUTCOMES)[number], number>;
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

function armStats(rows: SimulationRow[], baselineMode: string | null): ArmStats {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as ArmStats["outcomes"];
  const modes: string[] = [];
  let first: number | null = null;
  rows.forEach((r, i) => {
    outcomes[r.outcome] += 1;
    if (r.outcome !== "success") {
      first ??= i + 1;
      const mode = r.failure_type ?? r.outcome;
      if (!modes.includes(mode)) modes.push(mode);
    }
  });
  const failures = rows.length - outcomes.success;
  return {
    total_simulations: rows.length,
    outcomes,
    failures,
    failure_discovery_rate: rows.length ? Math.round((failures / rows.length) * 1000) / 1000 : null,
    unique_failure_modes: modes,
    new_failure_modes: modes.filter((m) => m !== baselineMode),
    first_failure_at: first,
    seeds: rows.map((r) => r.seed),
  };
}

export function compareTesting(rows: SimulationRow[]): Comparison {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const baselineRow = sorted.find((r) => r.arm === "baseline") ?? null;
  const baselineMode = baselineRow?.failure_type ?? null;
  const ai = armStats(sorted.filter((r) => r.arm === "ai"), baselineMode);
  const random = armStats(sorted.filter((r) => r.arm === "random"), baselineMode);

  const parts: string[] = [];
  if (!ai.total_simulations && !random.total_simulations) parts.push("No exploration runs yet.");
  else {
    parts.push(
      `AI-guided: ${ai.failures}/${ai.total_simulations} runs failed, ${ai.unique_failure_modes.length} unique failure mode(s).`,
      `Random: ${random.failures}/${random.total_simulations} runs failed, ${random.unique_failure_modes.length} unique failure mode(s).`,
    );
    if (ai.total_simulations !== random.total_simulations) parts.push("Budgets differ (experiment stopped early); compare with care.");
  }
  return {
    baseline: baselineRow ? { outcome: baselineRow.outcome, failure_type: baselineRow.failure_type } : null,
    simulations_per_arm: { ai: ai.total_simulations, random: random.total_simulations },
    equal_budget: ai.total_simulations === random.total_simulations,
    arms: { ai, random },
    summary: parts.join(" "),
  };
}

export const comparisonJson = (rows: SimulationRow[]) => compareTesting(rows) as unknown as Json;
