import { compareTesting } from "./comparison.ts";
import { type Config, modelCallCap } from "./config.ts";
import { type ChatJson, type ChatJsonRequest, NemotronError } from "./nemotron.ts";
import { analysisPrompt, generationPrompt, ref } from "./prompts.ts";
import { type Simulator, SimulatorError } from "./simulator.ts";
import type { Store } from "./store.ts";
import type { AnalysisRow, Arm, Experiment, Json, Params, Proposal, SimRun, SimulationRow } from "./types.ts";
import { analysisSchema, paramsKey, proposalSchema, validateAnalysis, validateProposals } from "./validation.ts";

export interface Deps {
  store: Store;
  llm: ChatJson;
  sim: Simulator;
  config: Config;
}

export class WorkflowError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message);
    this.name = "WorkflowError";
  }
}

const SEED_MAX = 2 ** 31 - 1;
const MAX_CONSECUTIVE_ERRORS = 3;
const RANDOM_SEED_OFFSET = 7777;

const seedFor = (base: number, iteration: number, index: number) => (base + iteration * 1000 + index) % SEED_MAX;

export interface StartInput {
  initial_params?: unknown;
  max_iterations?: unknown;
  scenarios_per_iteration?: unknown;
  max_total_simulations?: unknown;
  base_seed?: unknown;
}

function optionalInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new WorkflowError(400, `${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export async function startExperiment(deps: Deps, input: StartInput): Promise<Experiment> {
  const { limits } = deps.config;
  const maxIterations = optionalInt(input.max_iterations, "max_iterations", 1, limits.maxIterations) ?? limits.maxIterations;
  const perIteration = optionalInt(input.scenarios_per_iteration, "scenarios_per_iteration", 1, limits.scenariosPerIteration) ??
    limits.scenariosPerIteration;
  const budget = optionalInt(input.max_total_simulations, "max_total_simulations", 2, limits.maxTotalSimulations) ?? limits.maxTotalSimulations;
  const baseSeed = optionalInt(input.base_seed, "base_seed", 0, SEED_MAX) ?? crypto.getRandomValues(new Uint32Array(1))[0] % SEED_MAX;

  if (input.initial_params !== undefined && (typeof input.initial_params !== "object" || input.initial_params === null || Array.isArray(input.initial_params))) {
    throw new WorkflowError(400, "initial_params must be an object of scenario parameters");
  }
  const [check] = await deps.sim.validate([(input.initial_params ?? {}) as Params]);
  if (!check.valid || !check.params) throw new WorkflowError(400, "invalid initial scenario parameters", check.errors);

  const running = await deps.store.countExperiments({ status: "running" });
  if (running >= limits.maxRunningExperiments) {
    throw new WorkflowError(429, `too many experiments running (${running}); try again shortly`);
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if ((await deps.store.countExperiments({ since })) >= limits.maxExperimentsPerDay) {
    throw new WorkflowError(429, "daily experiment limit reached");
  }

  return deps.store.createExperiment({
    model_id: deps.config.nebius.model,
    initial_scenario: check.params,
    simulation_budget: budget,
    max_iterations: maxIterations,
    scenarios_per_iteration: perIteration,
    base_seed: baseSeed,
  });
}

async function requireExperiment(deps: Deps, id: string): Promise<Experiment> {
  const exp = await deps.store.getExperiment(id);
  if (!exp) throw new WorkflowError(404, "experiment not found");
  return exp;
}

export async function stopExperiment(deps: Deps, id: string): Promise<Experiment> {
  const exp = await requireExperiment(deps, id);
  if (exp.status !== "running") return exp;
  const rows = await deps.store.listSimulations(id);
  const stopped = await deps.store.updateExperiment(id, { status: "stopped", comparison: compareTesting(rows) as unknown as Json }, "running");
  return stopped ?? (await requireExperiment(deps, id));
}

export async function experimentView(deps: Deps, id: string) {
  const exp = await requireExperiment(deps, id);
  const [simulations, analyses] = await Promise.all([deps.store.listSimulations(id), deps.store.listAnalyses(id)]);
  const { lock_until: _lock, ...experiment } = exp;
  const ai = simulations.filter((s) => s.arm !== "random").length;
  const random = simulations.filter((s) => s.arm === "random").length;
  return {
    experiment,
    progress: {
      phase: exp.phase,
      iteration: exp.current_iteration,
      max_iterations: exp.max_iterations,
      ai_simulations: ai,
      random_simulations: random,
      simulation_budget_per_arm: exp.simulation_budget,
      model_calls: exp.model_calls,
      model_call_cap: modelCallCap(exp.max_iterations),
    },
    simulations,
    analyses,
    comparison: exp.comparison ?? compareTesting(simulations),
  };
}

export async function simulationReplay(deps: Deps, experimentId: string, resultId: string) {
  const row = await deps.store.getSimulation(experimentId, resultId);
  if (!row) throw new WorkflowError(404, "simulation result not found");
  return row.replay;
}

export async function advanceExperiment(deps: Deps, id: string): Promise<{ step: string; experiment: Experiment }> {
  const exp = await requireExperiment(deps, id);
  if (exp.status !== "running") return { step: "none", experiment: exp };
  const locked = await deps.store.acquireLock(id, deps.config.limits.lockMs);
  if (!locked) return { step: "busy", experiment: exp };

  const phase = locked.phase;
  try {
    await runPhase(deps, locked);
    if (locked.error_count > 0) await deps.store.updateExperiment(id, { error_count: 0, error: null }, "running");
  } catch (e) {
    const message = errorMessage(e);
    const errorCount = locked.error_count + 1;
    const giveUp = errorCount >= MAX_CONSECUTIVE_ERRORS;
    const aiPhase = phase === "analyze" || phase === "generate";
    await deps.store.updateExperiment(
      id,
      {
        error: `${phase}: ${message}`,
        error_count: giveUp && aiPhase ? 0 : errorCount,
        ...(giveUp ? (aiPhase ? { phase: "random" as const } : { status: "failed" as const }) : {}),
      },
      "running",
    );
  } finally {
    await deps.store.releaseLock(id);
  }
  return { step: phase, experiment: await requireExperiment(deps, id) };
}

export function errorMessage(e: unknown): string {
  if (e instanceof WorkflowError || e instanceof SimulatorError) {
    return e.details.length ? `${e.message} (${e.details.slice(0, 5).join("; ")})` : e.message;
  }
  if (e instanceof NemotronError) return `Nemotron ${e.code}: ${e.message}`;
  return "internal error";
}

async function runPhase(deps: Deps, exp: Experiment): Promise<void> {
  switch (exp.phase) {
    case "baseline":
      return phaseBaseline(deps, exp);
    case "analyze":
      return withModelBudget(deps, exp, () => phaseAnalyze(deps, exp));
    case "generate":
      return withModelBudget(deps, exp, () => phaseGenerate(deps, exp));
    case "execute":
      return phaseExecute(deps, exp);
    case "random":
      return phaseRandom(deps, exp);
    case "compare":
      return phaseCompare(deps, exp);
    default:
      return;
  }
}

async function withModelBudget(deps: Deps, exp: Experiment, fn: () => Promise<void>) {
  if (exp.model_calls >= modelCallCap(exp.max_iterations)) {
    await deps.store.updateExperiment(exp.id, { phase: "random", error: "model call budget exhausted" }, "running");
    return;
  }
  await fn();
}

async function callModel(deps: Deps, exp: Experiment, req: ChatJsonRequest) {
  const fresh = await requireExperiment(deps, exp.id);
  if (fresh.model_calls >= modelCallCap(fresh.max_iterations)) throw new WorkflowError(429, "model call budget exhausted for this experiment");
  await deps.store.updateExperiment(exp.id, { model_calls: fresh.model_calls + 1 });
  return deps.llm(req);
}

async function stillRunning(deps: Deps, id: string): Promise<boolean> {
  return (await deps.store.getExperiment(id))?.status === "running";
}

async function recordRun(
  deps: Deps,
  exp: Experiment,
  run: SimRun,
  meta: { seq: number; arm: Arm; iteration: number; proposal_index: number | null; name: string | null; hypothesis: string | null; scenario_id: string },
): Promise<SimulationRow> {
  return deps.store.insertSimulation({
    experiment_id: exp.id,
    ...meta,
    seed: run.seed,
    params: run.params,
    scenario_config: run.scenario,
    outcome: run.outcome,
    failure_type: run.failure_mode,
    reason: run.reason,
    metrics: run.metrics,
    collision: run.collision,
    trajectory: run.replay.result.trajectory,
    replay: run.replay,
  });
}

const nextSeq = (rows: SimulationRow[]) => rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
const latest = (analyses: AnalysisRow[], kind: AnalysisRow["kind"], iteration?: number) =>
  analyses.filter((a) => a.kind === kind && (iteration === undefined || a.iteration === iteration)).at(-1) ?? null;

async function phaseBaseline(deps: Deps, exp: Experiment) {
  const rows = await deps.store.listSimulations(exp.id);
  if (!rows.some((r) => r.arm === "baseline")) {
    const run = await deps.sim.simulate({ params: exp.initial_scenario, seed: exp.base_seed % SEED_MAX, scenario_id: "baseline" });
    await recordRun(deps, exp, run, { seq: 1, arm: "baseline", iteration: 0, proposal_index: null, name: "Baseline", hypothesis: null, scenario_id: "baseline" });
  }
  await deps.store.updateExperiment(exp.id, { phase: "analyze", completed_simulations: Math.max(rows.length, 1) }, "running");
}

export async function analyzeResults(deps: Deps, exp: Experiment, focus: SimulationRow[], iteration: number): Promise<AnalysisRow> {
  const all = await deps.store.listSimulations(exp.id, { heavy: true });
  const executed = all.filter((r) => r.arm !== "random");
  const focusIds = new Set(focus.map((f) => f.id));
  const focusRows = all.filter((r) => focusIds.has(r.id));
  if (!focusRows.length) throw new WorkflowError(400, "no executed simulation results to analyse");
  const previous = latest(await deps.store.listAnalyses(exp.id), "analysis");
  const space = await deps.sim.parameterSpace();

  const { system, user } = analysisPrompt({
    space,
    baseline: exp.initial_scenario,
    focus: focusRows,
    history: executed.filter((r) => !focusIds.has(r.id)),
    previous,
  });
  const res = await callModel(deps, exp, { system, user, schemaName: "failure_analysis", schema: analysisSchema });
  const checked = validateAnalysis(res.data, [...executed, ...focusRows].map(ref));
  if (!checked.ok) throw new WorkflowError(502, "Nemotron returned an invalid analysis", checked.errors);
  const a = checked.value;
  return deps.store.insertAnalysis({
    experiment_id: exp.id,
    kind: "analysis",
    iteration,
    simulation_result_ids: focusRows.map((r) => r.id),
    failure_hypothesis: a.failure_hypothesis,
    confidence: a.confidence,
    observed_facts: a.observed_facts,
    evidence: a.evidence,
    recommendations: a.recommendations,
    recommended_next_experiment: a.recommended_next_experiment,
    limitations: a.limitations,
    proposed_scenarios: null,
    rejected_proposals: null,
    model_id: res.model,
    usage: res.usage,
  });
}

async function phaseAnalyze(deps: Deps, exp: Experiment) {
  const rows = await deps.store.listSimulations(exp.id);
  const aiRows = rows.filter((r) => r.arm !== "random");
  const focus = aiRows.filter((r) => r.iteration === exp.current_iteration);
  if (focus.length) await analyzeResults(deps, exp, focus, exp.current_iteration);
  const more = exp.current_iteration < exp.max_iterations && aiRows.length < exp.simulation_budget;
  await deps.store.updateExperiment(exp.id, { phase: more ? "generate" : "random" }, "running");
}

export async function generateProposals(deps: Deps, exp: Experiment, count: number) {
  const [rows, analyses, space] = await Promise.all([
    deps.store.listSimulations(exp.id),
    deps.store.listAnalyses(exp.id),
    deps.sim.parameterSpace(),
  ]);
  const executed = rows.filter((r) => r.arm !== "random");
  const analysis = latest(analyses, "analysis");
  const { system, user } = generationPrompt({ space, baseline: exp.initial_scenario, executed, analysis, count });
  const res = await callModel(deps, exp, { system, user, schemaName: "scenario_proposals", schema: proposalSchema(space) });

  const local = validateProposals(res.data, space, count);
  if (local.errors.length) throw new WorkflowError(502, "Nemotron returned invalid scenario proposals", local.errors);
  const rejected = [...local.rejected];

  const merged = local.valid.map((p) => ({ ...exp.initial_scenario, ...p.overrides }));
  const checks = merged.length ? await deps.sim.validate(merged) : [];
  const seen = new Set(executed.map((r) => paramsKey(r.params)));
  const iteration = exp.current_iteration + 1;
  const proposals: Proposal[] = [];
  local.valid.forEach((p, i) => {
    const check = checks[i];
    if (!check?.valid || !check.params) {
      rejected.push({ proposal: p as unknown as Json, errors: check?.errors ?? ["rejected by simulator"] });
      return;
    }
    const key = paramsKey(check.params);
    if (seen.has(key)) {
      rejected.push({ proposal: p as unknown as Json, errors: ["duplicate of an already executed or proposed scenario"] });
      return;
    }
    seen.add(key);
    proposals.push({ ...p, params: check.params, seed: seedFor(exp.base_seed, iteration, proposals.length) });
  });

  return { proposals, rejected, analysis, model: res.model, usage: res.usage, iteration };
}

async function phaseGenerate(deps: Deps, exp: Experiment) {
  const rows = await deps.store.listSimulations(exp.id);
  const remaining = exp.simulation_budget - rows.filter((r) => r.arm !== "random").length;
  const count = Math.min(exp.scenarios_per_iteration, remaining);
  if (count <= 0) {
    await deps.store.updateExperiment(exp.id, { phase: "random" }, "running");
    return;
  }
  const g = await generateProposals(deps, exp, count);
  await deps.store.insertAnalysis({
    experiment_id: exp.id,
    kind: "proposal",
    iteration: g.iteration,
    simulation_result_ids: [],
    failure_hypothesis: g.analysis?.failure_hypothesis ?? null,
    confidence: g.analysis?.confidence ?? null,
    observed_facts: null,
    evidence: null,
    recommendations: null,
    recommended_next_experiment: null,
    limitations: null,
    proposed_scenarios: g.proposals,
    rejected_proposals: g.rejected,
    model_id: g.model,
    usage: g.usage,
  });
  if (!g.proposals.length) {
    throw new WorkflowError(502, "no valid scenario proposals", g.rejected.flatMap((r) => r.errors).slice(0, 5));
  }
  await deps.store.updateExperiment(exp.id, { phase: "execute" }, "running");
}

async function phaseExecute(deps: Deps, exp: Experiment) {
  const iteration = exp.current_iteration + 1;
  const proposalRow = latest(await deps.store.listAnalyses(exp.id), "proposal", iteration);
  const proposals = proposalRow?.proposed_scenarios ?? [];
  let rows = await deps.store.listSimulations(exp.id);
  const done = new Set(rows.filter((r) => r.arm === "ai" && r.iteration === iteration).map((r) => r.proposal_index));

  for (const [i, p] of proposals.entries()) {
    if (done.has(i)) continue;
    if (rows.filter((r) => r.arm !== "random").length >= exp.simulation_budget) break;
    if (!(await stillRunning(deps, exp.id))) return;
    const scenarioId = `ai_i${iteration}_${i + 1}`;
    const run = await deps.sim.simulate({ params: p.params, seed: p.seed, scenario_id: scenarioId });
    const row = await recordRun(deps, exp, run, {
      seq: nextSeq(rows), arm: "ai", iteration, proposal_index: i, name: p.name, hypothesis: p.hypothesis, scenario_id: scenarioId,
    });
    rows = [...rows, row];
    await deps.store.updateExperiment(exp.id, { completed_simulations: rows.length }, "running");
  }
  await deps.store.updateExperiment(exp.id, { phase: "analyze", current_iteration: iteration, completed_simulations: rows.length }, "running");
}

async function phaseRandom(deps: Deps, exp: Experiment) {
  let rows = await deps.store.listSimulations(exp.id);
  const target = rows.filter((r) => r.arm === "ai").length;
  const existing = rows.filter((r) => r.arm === "random").length;
  if (target > existing) {
    const items = await deps.sim.randomParams(target, (exp.base_seed + RANDOM_SEED_OFFSET) % SEED_MAX);
    for (let i = existing; i < target; i++) {
      if (!(await stillRunning(deps, exp.id))) return;
      const scenarioId = `random_${i + 1}`;
      const run = await deps.sim.simulate({ params: items[i].params, seed: items[i].seed, scenario_id: scenarioId });
      const row = await recordRun(deps, exp, run, {
        seq: nextSeq(rows), arm: "random", iteration: 0, proposal_index: i, name: `Random #${i + 1}`, hypothesis: null, scenario_id: scenarioId,
      });
      rows = [...rows, row];
      await deps.store.updateExperiment(exp.id, { completed_simulations: rows.length }, "running");
    }
  }
  await deps.store.updateExperiment(exp.id, { phase: "compare", completed_simulations: rows.length }, "running");
}

async function phaseCompare(deps: Deps, exp: Experiment) {
  const rows = await deps.store.listSimulations(exp.id);
  await deps.store.updateExperiment(
    exp.id,
    { comparison: compareTesting(rows) as unknown as Json, phase: "done", status: "completed" },
    "running",
  );
}

export async function analyzeSimulationStandalone(deps: Deps, id: string, resultIds: unknown) {
  const exp = await requireExperiment(deps, id);
  if (exp.status === "running") throw new WorkflowError(409, "experiment is running; its workflow performs analyses");
  const rows = (await deps.store.listSimulations(id)).filter((r) => r.arm !== "random");
  let focus = rows.filter((r) => r.iteration === exp.current_iteration);
  if (resultIds !== undefined) {
    if (!Array.isArray(resultIds) || resultIds.length === 0 || resultIds.length > 20 || !resultIds.every((x) => typeof x === "string")) {
      throw new WorkflowError(400, "simulation_result_ids must be a non-empty array of ids");
    }
    const wanted = new Set(resultIds);
    focus = rows.filter((r) => wanted.has(r.id));
    if (focus.length !== wanted.size) throw new WorkflowError(404, "some simulation results were not found in this experiment");
  }
  if (exp.model_calls >= modelCallCap(exp.max_iterations)) throw new WorkflowError(429, "model call budget exhausted for this experiment");
  return analyzeResults(deps, exp, focus, exp.current_iteration);
}

export async function generateScenariosStandalone(deps: Deps, id: string) {
  const exp = await requireExperiment(deps, id);
  if (exp.status === "running") throw new WorkflowError(409, "experiment is running; its workflow generates scenarios");
  if (exp.model_calls >= modelCallCap(exp.max_iterations)) throw new WorkflowError(429, "model call budget exhausted for this experiment");
  const g = await generateProposals(deps, exp, exp.scenarios_per_iteration);
  await deps.store.insertAnalysis({
    experiment_id: exp.id,
    kind: "proposal",
    iteration: g.iteration,
    simulation_result_ids: [],
    failure_hypothesis: g.analysis?.failure_hypothesis ?? null,
    confidence: g.analysis?.confidence ?? null,
    observed_facts: null,
    evidence: null,
    recommendations: null,
    recommended_next_experiment: null,
    limitations: null,
    proposed_scenarios: g.proposals,
    rejected_proposals: g.rejected,
    model_id: g.model,
    usage: g.usage,
  });
  return { proposed_scenarios: g.proposals, rejected_proposals: g.rejected, executed: false };
}
