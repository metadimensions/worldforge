import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

import { makeSimulator } from "./simulator.ts";
import { FakeLlm, makeDeps, testConfig } from "./testing.ts";
import { advanceExperiment, startExperiment } from "./workflow.ts";

const PYTHON = new URL("../../../.venv/bin/python", import.meta.url).pathname;
const TOKEN = "integration-token";

async function withWorker(fn: (url: string) => Promise<void>) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = new Deno.Command(PYTHON, {
    args: ["-m", "worldforge.worker", "--port", String(port)],
    env: { WORKER_TOKEN: TOKEN },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`${url}/health`);
        await res.body?.cancel();
        if (res.ok) break;
      } catch { }
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(url);
  } finally {
    child.kill();
    await child.status;
  }
}

function realDeps(url: string, llm = new FakeLlm()) {
  const config = testConfig({ SIMULATOR_URL: url, SIMULATOR_TOKEN: TOKEN });
  return makeDeps({ config, llm, sim: makeSimulator(config.simulator) });
}

Deno.test("worker rejects unauthenticated and invalid requests", async () => {
  await withWorker(async (url) => {
    const noAuth = makeSimulator({ url, token: undefined, timeoutMs: 5000 });
    const err = await noAuth.parameterSpace().catch((e) => e);
    assertEquals(err.status, 401);
    const sim = makeSimulator({ url, token: TOKEN, timeoutMs: 5000 });
    const [bad, geometry, ok] = await sim.validate([{ forklift_speed: 9999 }, { forklift_width: 70, cross_aisle_width: 60 }, {}]);
    assert(!bad.valid && bad.errors[0].includes("out of range"));
    assert(!geometry.valid && geometry.errors[0].includes("invalid obstacle placement"));
    assert(ok.valid);
  });
});

Deno.test("failure analysis is built from the actual collision data", async () => {
  await withWorker(async (url) => {
    const { deps, llm, store } = realDeps(url);
    const exp = await startExperiment(deps, { base_seed: 42 });
    await advanceExperiment(deps, exp.id);
    await advanceExperiment(deps, exp.id);
    const [baseline] = await store.listSimulations(exp.id, { heavy: true });
    assertEquals(baseline.outcome, "collision");
    assertEquals(baseline.collision?.obstacle_id, "forklift");
    assertEquals(baseline.collision?.t, 4.35);
    assertEquals(baseline.failure_type, "collision:moving:side");

    const prompt = JSON.parse(llm.requests[0].user);
    const report = prompt.focus_batch[0];
    assertEquals(report.ref, "S1");
    assertEquals(report.outcome, "collision");
    assertEquals(report.collision.obstacle_id, "forklift");
    assertEquals(report.collision.t, 4.35);
    assertEquals([report.collision.robot_x, report.collision.robot_y], [403, 305]);
    assertEquals(report.collision.obstacle_y, 276);
    assertEquals(report.metrics.min_clearance, -6);
    assertEquals((await store.listAnalyses(exp.id))[0].failure_hypothesis, "The reactive controller does not predict the forklift's motion.");
  });
});

Deno.test("AI-generated scenarios are validated and executed by the real simulator", async () => {
  await withWorker(async (url) => {
    const llm = new FakeLlm();
    llm.proposals = () => ({
      proposed_scenarios: [
        { name: "Late forklift", hypothesis: "h", prediction: "robot passes first", rationale: "r", parameters: { forklift_start_time: 6.5 } },
        { name: "Bad geometry", hypothesis: "h", prediction: "p", rationale: "r", parameters: { forklift_width: 70, cross_aisle_width: 60 } },
        { name: "Northbound", hypothesis: "h", prediction: "p", rationale: "r", parameters: { forklift_direction: "northbound" } },
      ],
    });
    const { deps, store } = realDeps(url, llm);
    const exp = await startExperiment(deps, { base_seed: 42, max_iterations: 1 });
    for (let i = 0; i < 4; i++) await advanceExperiment(deps, exp.id);

    const proposal = (await store.listAnalyses(exp.id)).find((a) => a.kind === "proposal")!;
    assertEquals(proposal.proposed_scenarios!.map((p) => p.name), ["Late forklift", "Northbound"]);
    assert(proposal.rejected_proposals![0].errors[0].includes("invalid obstacle placement"));

    const ai = (await store.listSimulations(exp.id)).filter((r) => r.arm === "ai");
    assertEquals(ai.map((r) => r.name), ["Late forklift", "Northbound"]);
    const sim = makeSimulator({ url, token: TOKEN, timeoutMs: 5000 });
    for (const row of ai) {
      const direct = await sim.simulate({ params: row.params, seed: row.seed, scenario_id: "check" });
      assertEquals([row.outcome, row.failure_type, row.metrics], [direct.outcome, direct.failure_mode, direct.metrics]);
    }
    assertEquals(ai[0].outcome, "success");
  });
});

Deno.test("random baseline uses the same budget and bounds, deterministically", async () => {
  await withWorker(async (url) => {
    const run = async () => {
      const { deps, store } = realDeps(url);
      const exp = await startExperiment(deps, { base_seed: 99, max_iterations: 1, scenarios_per_iteration: 3 });
      let e = exp;
      for (let i = 0; i < 20 && e.status === "running"; i++) e = (await advanceExperiment(deps, exp.id)).experiment;
      return { e, rows: await store.listSimulations(exp.id) };
    };
    const a = await run();
    const b = await run();
    assertEquals(a.e.status, "completed");
    const random = a.rows.filter((r) => r.arm === "random");
    assertEquals(random.length, a.rows.filter((r) => r.arm === "ai").length);
    assertEquals(random.map((r) => [r.params, r.seed, r.outcome]), b.rows.filter((r) => r.arm === "random").map((r) => [r.params, r.seed, r.outcome]));
    const cmp = a.e.comparison as any;
    assertEquals(cmp.arms.random.total_simulations, random.length);
    assertEquals(cmp.arms.random.failures, random.filter((r) => r.outcome !== "success").length);
    assertEquals(cmp.equal_budget, true);
  });
});
