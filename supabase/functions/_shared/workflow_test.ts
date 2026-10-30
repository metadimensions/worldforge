import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";

import { handlers } from "./handlers.ts";
import { NemotronError } from "./nemotron.ts";
import { FakeLlm, makeDeps, testConfig } from "./testing.ts";
import type { Deps } from "./workflow.ts";
import { advanceExperiment, experimentView, startExperiment, stopExperiment, WorkflowError } from "./workflow.ts";

async function runToEnd(deps: Deps, id: string, maxSteps = 50) {
  for (let i = 0; i < maxSteps; i++) {
    const { experiment } = await advanceExperiment(deps, id);
    if (experiment.status !== "running") return experiment;
  }
  throw new Error("workflow did not terminate");
}

Deno.test("full bounded experiment: baseline, 3 AI iterations, random arm, comparison", async () => {
  const { deps, store, llm, sim } = makeDeps();
  const exp = await startExperiment(deps, { base_seed: 42 });
  const done = await runToEnd(deps, exp.id);

  assertEquals(done.status, "completed");
  assertEquals(done.phase, "done");
  const rows = await store.listSimulations(exp.id);
  const byArm = (arm: string) => rows.filter((r) => r.arm === arm);
  assertEquals(byArm("baseline").length, 1);
  assertEquals(byArm("ai").length, 9);
  assertEquals(byArm("random").length, 9);
  assertEquals(done.completed_simulations, 19);
  assertEquals(sim.calls.length, 19);
  assertEquals(llm.requests.length, 7);
  assertEquals(done.model_calls, 7);

  for (const r of await store.listSimulations(exp.id, { heavy: true })) {
    assert(r.trajectory.length > 0 && r.replay.schema_version === 1);
  }
  const analyses = await store.listAnalyses(exp.id);
  assertEquals(analyses.filter((a) => a.kind === "analysis").length, 4);
  assertEquals(analyses.filter((a) => a.kind === "proposal").length, 3);

  const cmp = done.comparison as any;
  assertEquals(cmp.simulations_per_arm, { ai: 9, random: 9 });
  assertEquals(cmp.arms.ai.failures, 6);
  assertEquals(cmp.arms.ai.outcomes.success, 3);
  assertEquals(cmp.arms.ai.first_failure_at, 1);
});

Deno.test("experiment is reproducible for the same base seed", async () => {
  const a = makeDeps();
  const b = makeDeps();
  const ea = await runToEnd(a.deps, (await startExperiment(a.deps, { base_seed: 7 })).id);
  const eb = await runToEnd(b.deps, (await startExperiment(b.deps, { base_seed: 7 })).id);
  const strip = (rows: any[]) => rows.map((r) => [r.arm, r.seed, r.params, r.outcome]);
  assertEquals(strip(await a.store.listSimulations(ea.id)), strip(await b.store.listSimulations(eb.id)));
  assertEquals(ea.comparison, eb.comparison);
});

Deno.test("budget enforcement: requests can lower but never raise limits", async () => {
  const { deps, store } = makeDeps();
  await assertRejects(() => startExperiment(deps, { max_total_simulations: 500 }), WorkflowError, "max_total_simulations");
  await assertRejects(() => startExperiment(deps, { max_iterations: 0 }), WorkflowError);
  const exp = await startExperiment(deps, { max_total_simulations: 4, scenarios_per_iteration: 3 });
  await runToEnd(deps, exp.id);
  const rows = await store.listSimulations(exp.id);
  assertEquals(rows.filter((r) => r.arm !== "random").length, 4);
  assertEquals(rows.filter((r) => r.arm === "random").length, 3);
});

Deno.test("running and daily experiment limits", async () => {
  const { deps } = makeDeps({ config: testConfig({ MAX_RUNNING_EXPERIMENTS: "1" }) });
  await startExperiment(deps, {});
  await assertRejects(() => startExperiment(deps, {}), WorkflowError, "too many experiments");
  const d = makeDeps({ config: testConfig({ MAX_EXPERIMENTS_PER_DAY: "1" }) });
  const first = await startExperiment(d.deps, {});
  await stopExperiment(d.deps, first.id);
  await assertRejects(() => startExperiment(d.deps, {}), WorkflowError, "daily");
});

Deno.test("cancellation stops scheduling and preserves completed results", async () => {
  const { deps, store, sim } = makeDeps();
  const exp = await startExperiment(deps, {});
  for (let i = 0; i < 4; i++) await advanceExperiment(deps, exp.id);
  const before = (await store.listSimulations(exp.id)).length;
  assertEquals(before, 4);
  const stopped = await stopExperiment(deps, exp.id);
  assertEquals(stopped.status, "stopped");
  const { step } = await advanceExperiment(deps, exp.id);
  assertEquals(step, "none");
  assertEquals((await store.listSimulations(exp.id)).length, before);
  assertEquals(sim.calls.length, before);
  assert(stopped.comparison !== null);
});

Deno.test("stop during a batch: remaining simulations are not scheduled", async () => {
  const { deps, store, sim } = makeDeps();
  const exp = await startExperiment(deps, {});
  for (let i = 0; i < 3; i++) await advanceExperiment(deps, exp.id);
  const original = sim.simulate.bind(sim);
  sim.simulate = async (item) => {
    const r = await original(item);
    await store.updateExperiment(exp.id, { status: "stopped" });
    return r;
  };
  await advanceExperiment(deps, exp.id);
  assertEquals((await store.listSimulations(exp.id)).filter((r) => r.arm === "ai").length, 1);
});

Deno.test("invalid model response is recorded and retried; results are preserved", async () => {
  const llm = new FakeLlm();
  let bad = 1;
  llm.analysis = () => (bad-- > 0 ? { nonsense: true } : validAnalysis());
  const { deps, store } = makeDeps({ llm });
  const exp = await startExperiment(deps, {});
  await advanceExperiment(deps, exp.id);
  await advanceExperiment(deps, exp.id);
  let e = await store.getExperiment(exp.id);
  assertEquals([e!.status, e!.phase, e!.error_count], ["running", "analyze", 1]);
  assert(e!.error!.includes("invalid analysis"));
  assertEquals((await store.listSimulations(exp.id)).length, 1);
  await advanceExperiment(deps, exp.id);
  e = await store.getExperiment(exp.id);
  assertEquals([e!.phase, e!.error_count], ["generate", 0]);
  assertEquals(llm.requests.map((r) => Boolean(r.plain)), [false, true]);
});

Deno.test("repeated AI failures skip to the random arm instead of losing the experiment", async () => {
  const llm = new FakeLlm();
  llm.fn = () => Promise.reject(new NemotronError("timeout", "Token Factory did not respond within 60000 ms"));
  const { deps, store } = makeDeps({ llm });
  const exp = await startExperiment(deps, {});
  const done = await runToEnd(deps, exp.id);
  assertEquals(done.status, "completed");
  assert(done.error!.includes("timeout"));
  const rows = await store.listSimulations(exp.id);
  assertEquals(rows.length, 1);
  assert(done.model_calls <= 3);
});

Deno.test("model call cap bounds Nemotron usage", async () => {
  const llm = new FakeLlm();
  llm.proposals = () => ({ proposed_scenarios: [] });
  const { deps } = makeDeps({ llm });
  const exp = await startExperiment(deps, {});
  const done = await runToEnd(deps, exp.id);
  assertEquals(done.status, "completed");
  assert(llm.requests.length <= 2 * 3 + 4, `made ${llm.requests.length} calls`);
});

Deno.test("concurrent advance calls do not run the same step twice", async () => {
  const { deps, sim } = makeDeps();
  const exp = await startExperiment(deps, {});
  const [a, b] = await Promise.all([advanceExperiment(deps, exp.id), advanceExperiment(deps, exp.id)]);
  assertEquals([a.step, b.step].sort(), ["baseline", "busy"]);
  assertEquals(sim.calls.length, 1);
});

Deno.test("experiment view exposes progress but not the lock", async () => {
  const { deps } = makeDeps();
  const exp = await startExperiment(deps, {});
  await advanceExperiment(deps, exp.id);
  const view = await experimentView(deps, exp.id);
  assertEquals(view.progress.ai_simulations, 1);
  assert(!("lock_until" in view.experiment));
  assertEquals(view.simulations[0].replay, null);
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/fn", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });

Deno.test("handlers reject invalid JSON and ids", async () => {
  const { deps } = makeDeps();
  assertEquals((await handlers["start-experiment"](post("{not json"), deps)).status, 400);
  assertEquals((await handlers["get-experiment"](post({ experiment_id: "123" }), deps)).status, 400);
  assertEquals((await handlers["get-experiment"](post({ experiment_id: crypto.randomUUID() }), deps)).status, 404);
  const bad = await handlers["start-experiment"](post({ initial_params: { warp_drive: 1 } }), deps);
  assertEquals(bad.status, 400);
  assert((await bad.json()).details[0].includes("unsupported parameter"));
  assertEquals((await handlers["start-experiment"](new Request("http://x", { method: "GET" }), deps)).status, 405);
});

Deno.test("handlers: start runs the baseline; access code is enforced when configured", async () => {
  const { deps } = makeDeps();
  const res = await handlers["start-experiment"](post({}), deps);
  assertEquals(res.status, 200);
  const view = await res.json();
  assertEquals(view.simulations[0].arm, "baseline");
  assertEquals(view.experiment.phase, "analyze");
  assert(!JSON.stringify(view).includes("test-key"));

  const locked = makeDeps({ config: testConfig({ WORLDFORGE_ACCESS_CODE: "open-sesame" }) });
  assertEquals((await handlers["start-experiment"](post({}), locked.deps)).status, 401);
  assertEquals((await handlers["start-experiment"](post({}, { "x-worldforge-access-code": "open-sesame" }), locked.deps)).status, 200);
});

Deno.test("handlers: missing Nemotron key surfaces as a configuration error", async () => {
  const { deps, store } = makeDeps();
  const exp = await startExperiment(deps, {});
  await advanceExperiment(deps, exp.id);
  await stopExperiment(deps, exp.id);
  deps.llm = () => Promise.reject(new NemotronError("missing_key", "NEBIUS_API_KEY is not configured"));
  const res = await handlers["analyze-simulation"](post({ experiment_id: exp.id }), deps);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, "missing_key");
  assertEquals((await store.listAnalyses(exp.id)).length, 0);
});

function validAnalysis() {
  return {
    observed_facts: [{ statement: "S1 collided.", result_refs: ["S1"] }],
    failure_hypothesis: "No motion prediction.",
    confidence: "low",
    evidence: [{ statement: "No waiting before impact.", result_refs: ["S1"] }],
    recommendations: [],
    recommended_next_experiment: "Vary timing.",
    limitations: [],
  };
}
