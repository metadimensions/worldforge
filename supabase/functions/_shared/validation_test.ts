import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

import { MINI_SPACE, proposals, VALID_ANALYSIS } from "./testing.ts";
import { cleanName, proposalSchema, validateAnalysis, validateProposals } from "./validation.ts";

Deno.test("valid analysis passes", () => {
  const r = validateAnalysis(VALID_ANALYSIS, ["S1"]);
  assert(r.ok);
  assertEquals(r.value.confidence, "medium");
});

Deno.test("analysis may not cite simulations that were never executed", () => {
  const bad = { ...VALID_ANALYSIS, evidence: [{ statement: "S7 failed too", result_refs: ["S7"] }] };
  const r = validateAnalysis(bad, ["S1"]);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("unexecuted simulation")));
});

Deno.test("analysis with missing or malformed fields is rejected", () => {
  for (const bad of [null, [], { ...VALID_ANALYSIS, confidence: "certain" }, { ...VALID_ANALYSIS, failure_hypothesis: "" }, { ...VALID_ANALYSIS, evidence: "x" }]) {
    assert(!validateAnalysis(bad, ["S1"]).ok, JSON.stringify(bad));
  }
});

Deno.test("proposal schema lists exactly the supported parameters", () => {
  const schema = proposalSchema(MINI_SPACE) as any;
  const params = schema.properties.proposed_scenarios.items.properties.parameters;
  assertEquals(params.required.sort(), Object.keys(MINI_SPACE.parameters).sort());
  assertEquals(params.additionalProperties, false);
});

Deno.test("unsupported, out-of-range and wrongly typed parameters are rejected", () => {
  const data = proposals([2.5]);
  const base = data.proposed_scenarios[0];
  data.proposed_scenarios.push(
    { ...base, name: "unsupported", parameters: { ...base.parameters, teleport_robot: 1 } as any },
    { ...base, name: "range", parameters: { ...base.parameters, forklift_speed: 900 } as any },
    { ...base, name: "type", parameters: { ...base.parameters, forklift_start_time: "soon" } as any },
    { ...base, name: "enum", parameters: { ...base.parameters, forklift_direction: "up" } as any },
    { ...base, name: "nan", parameters: { ...base.parameters, forklift_speed: NaN } as any },
  );
  const r = validateProposals(data, MINI_SPACE, 10);
  assertEquals(r.valid.map((p) => p.name), [base.name]);
  assertEquals(r.valid[0].overrides, { forklift_start_time: 2.5 });
  const errs = r.rejected.map((x) => x.errors.join(" "));
  assert(errs[0].includes("unsupported parameter"));
  assert(errs[1].includes("out of range"));
  assert(errs[2].includes("finite number"));
  assert(errs[3].includes("must be one of"));
  assert(errs[4].includes("finite number"));
});

Deno.test("invalid proposal JSON and per-iteration budget", () => {
  assertEquals(validateProposals({ ideas: [] }, MINI_SPACE, 3).errors.length, 1);
  assertEquals(validateProposals({ scenarios: proposals([2.5]).proposed_scenarios }, MINI_SPACE, 3).valid.length, 1);
  assertEquals(validateProposals(proposals([2.5]).proposed_scenarios, MINI_SPACE, 3).valid.length, 1);
  assertEquals(validateProposals("[]", MINI_SPACE, 3).errors.length, 1);
  const r = validateProposals(proposals([2.1, 2.2, 2.3, 2.4]), MINI_SPACE, 3);
  assertEquals(r.valid.length, 3);
  assert(r.rejected[0].errors[0].includes("budget"));
});

Deno.test("shape normalisation: plain strings become items and citations are read from the text", () => {
  const loose = { ...VALID_ANALYSIS, observed_facts: "S1 collided at t=4.35 s.", evidence: ["S1 had no wait steps."], limitations: "2D only." };
  const r = validateAnalysis(loose, ["S1"]);
  assert(r.ok);
  assertEquals(r.value.observed_facts, [{ statement: "S1 collided at t=4.35 s.", result_refs: ["S1"] }]);
  assertEquals(r.value.limitations, ["2D only."]);
  assert(!validateAnalysis({ ...VALID_ANALYSIS, evidence: ["no citation here"] }, ["S1"]).ok);
  assert(!validateAnalysis({ ...VALID_ANALYSIS, evidence: ["S9 also failed"] }, ["S1"]).ok);
});

Deno.test("scenario names lose run ids and test numbers; predicted outcome is normalised", () => {
  assertEquals(cleanName("S4-HighForkliftSpeed"), "High Forklift Speed");
  assertEquals(cleanName("T1_start_time_2.4"), "start time 2.4");
  assertEquals(cleanName("RobotSpeedStress"), "Robot Speed Stress");
  assertEquals(cleanName("Late Northbound Forklift"), "Late Northbound Forklift");
  assertEquals(cleanName("S5"), "S5");
  const data = proposals([2.5, 2.6, 2.7]);
  data.proposed_scenarios[0].name = "S4-HighFork";
  (data.proposed_scenarios[0] as any).predicted_outcome = "Collision";
  (data.proposed_scenarios[1] as any).predicted_outcome = "no path";
  (data.proposed_scenarios[2] as any).predicted_outcome = "explodes";
  const r = validateProposals(data, MINI_SPACE, 3);
  assertEquals(r.valid[0].name, "High Fork");
  assertEquals(r.valid.map((p) => p.predicted_outcome), ["collision", "no_path", null]);
});
