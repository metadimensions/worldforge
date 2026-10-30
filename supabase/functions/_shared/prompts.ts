import type { AnalysisRow, Json, ParameterSpace, Params, SimulationRow } from "./types.ts";

export const ref = (row: Pick<SimulationRow, "seq">) => `S${row.seq}`;

const round = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

const SYSTEM_UNDER_TEST = `System under test (WorldForge baseline robot, 2D kinematic simulator):
- Global planner: A* on an occupancy grid built from STATIC obstacles only (racks), inflated by robot radius + 5.
- Local controller: drives straight to the next waypoint at up to robot_speed. Before each 0.05 s step it checks
  whether its own next step would overlap any obstacle at that obstacle's CURRENT position; if so it waits, and
  after 20 blocked steps it replans treating currently visible moving obstacles as static.
- A collision is recorded whenever the robot circle overlaps an obstacle, whoever moved into whom.
- Coordinates: origin top-left, +x east, +y south; 1 unit = 1 cm.`;

function diffFromBaseline(params: Params, baseline: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) if (baseline[k] !== v) out[k] = v;
  return out;
}

export function simulationReport(row: SimulationRow, baseline: Params): Record<string, Json> {
  const traj = row.trajectory ?? [];
  const statusCounts: Record<string, number> = {};
  for (const p of traj) statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
  const every = Math.max(1, Math.ceil(traj.length / 8));
  const samples = traj
    .filter((_, i) => i % every === 0 || i === traj.length - 1)
    .map((p) => ({ t: round(p.t), x: round(p.x, 1), y: round(p.y, 1), heading_deg: round((p.heading * 180) / Math.PI, 0), status: p.status }));

  const report: Record<string, Json> = {
    ref: ref(row),
    arm: row.arm,
    name: row.name ?? (row.arm === "baseline" ? "baseline" : null),
    changed_parameters: diffFromBaseline(row.params, baseline) as Json,
    outcome: row.outcome,
    reason: row.reason,
    failure_type: row.failure_type,
    metrics: Object.fromEntries(Object.entries(row.metrics).map(([k, v]) => [k, round(v)])),
    trajectory: { points: traj.length, status_counts: statusCounts, samples } as Json,
  };
  if (row.collision) {
    const c = row.collision;
    const last = traj[traj.length - 1];
    const track = row.replay?.moving_obstacle_tracks?.find((t) => t.id === c.obstacle_id);
    const at = track?.samples?.[track.samples.length - 1];
    report.collision = {
      t: c.t,
      step: c.step,
      robot_x: round(c.x, 1),
      robot_y: round(c.y, 1),
      robot_heading_deg: last ? round((last.heading * 180) / Math.PI, 0) : null,
      obstacle_id: c.obstacle_id,
      obstacle_x: at ? round(at.x, 1) : null,
      obstacle_y: at ? round(at.y, 1) : null,
    };
  }
  return report;
}

export function analysisPrompt(args: {
  space: ParameterSpace;
  baseline: Params;
  focus: SimulationRow[];
  history: SimulationRow[];
  previous: AnalysisRow | null;
}) {
  const { space, baseline, focus, history, previous } = args;
  const system = `You are WorldForge AI, a robotics test engineer analysing ACTUAL results from a deterministic simulator.
${SYSTEM_UNDER_TEST}

Rules:
- observed_facts: only facts that appear in the provided simulation reports. Each cites the refs (e.g. "S1") it comes from.
- failure_hypothesis: your explanation of the failure mechanism. It is a hypothesis, not a fact.
- evidence: observations from the reports that support or weaken the hypothesis; cite refs.
- recommendations / recommended_next_experiment: what to test next. These are untested ideas.
- Never state or imply that a scenario that is not in the reports has failed or succeeded.
- Only cite refs that appear in the reports. If all runs succeeded, say what that shows.
- limitations: include caveats such as the simplified 2D kinematic simulator.
- Be concise: each string under 300 characters.

Respond with ONE JSON object, exactly this shape (arrays may hold 1-6 items):
{
  "observed_facts": [{"statement": "<fact from a report>", "result_refs": ["S1"]}],
  "failure_hypothesis": "<one or two sentences>",
  "confidence": "low" | "medium" | "high",
  "evidence": [{"statement": "<observation supporting or weakening the hypothesis>", "result_refs": ["S1"]}],
  "recommendations": ["<untested idea>"],
  "recommended_next_experiment": "<one sentence>",
  "limitations": ["<caveat>"]
}`;
  const user = JSON.stringify({
    task: "Analyse the focus simulation batch and update the failure hypothesis.",
    parameter_space: space.parameters,
    baseline_parameters: baseline,
    previous_hypothesis: previous ? { text: previous.failure_hypothesis, confidence: previous.confidence } : null,
    earlier_runs: history.map((r) => ({ ref: ref(r), name: r.name, changed_parameters: diffFromBaseline(r.params, baseline), outcome: r.outcome, failure_type: r.failure_type })),
    focus_batch: focus.map((r) => simulationReport(r, baseline)),
  });
  return { system, user };
}

export function generationPrompt(args: {
  space: ParameterSpace;
  baseline: Params;
  executed: SimulationRow[];
  analysis: AnalysisRow | null;
  count: number;
}) {
  const { space, baseline, executed, analysis, count } = args;
  const system = `You are WorldForge AI, designing the next simulation experiments to discover robot failure modes.
${SYSTEM_UNDER_TEST}

Rules:
- Propose exactly ${count} scenario(s) as parameter overrides of the baseline. Use ONLY the listed parameters,
  within their [min, max] ranges; set a parameter to null to keep its baseline value.
- forklift_width must be at least 2 units smaller than cross_aisle_width.
- Each scenario must test, refine or try to falsify the current hypothesis, or probe a different, plausible
  failure mode. Do not repeat a parameter combination that was already executed. Make the scenarios differ.
- "prediction" is your expectation if the hypothesis is right. It is NOT a result: these scenarios have not run.
- Keep each string under 250 characters.

Respond with ONE JSON object, exactly this shape:
{
  "proposed_scenarios": [
    {
      "name": "<short name>",
      "hypothesis": "<what this scenario tests>",
      "prediction": "<expected outcome if the hypothesis holds (untested)>",
      "rationale": "<why this is informative>",
      "parameters": { "<parameter name>": <number | enum string | null>, ... }
    }
  ]
}
Only include parameter names from parameter_space; omitted or null parameters keep their baseline values.`;
  const user = JSON.stringify({
    task: `Propose ${count} targeted scenario(s).`,
    parameter_space: space.parameters,
    fixed_layout: space.fixed,
    baseline_parameters: baseline,
    current_hypothesis: analysis
      ? { text: analysis.failure_hypothesis, confidence: analysis.confidence, recommended_next_experiment: analysis.recommended_next_experiment }
      : null,
    executed_runs: executed.map((r) => ({
      ref: ref(r),
      changed_parameters: diffFromBaseline(r.params, baseline),
      outcome: r.outcome,
      failure_type: r.failure_type,
      min_clearance: round(r.metrics.min_clearance ?? null),
      goal_progress: round(r.metrics.goal_progress ?? null),
    })),
  });
  return { system, user };
}
