import type { EvidenceItem, Json, Outcome, ParameterSpace, Params } from "./types.ts";

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_TEXT = 1000;
const MAX_ITEMS = 8;

export interface Analysis {
  observed_facts: EvidenceItem[];
  failure_hypothesis: string;
  confidence: "low" | "medium" | "high";
  evidence: EvidenceItem[];
  recommendations: string[];
  recommended_next_experiment: string;
  limitations: string[];
}

const evidenceSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["statement", "result_refs"],
    properties: { statement: { type: "string" }, result_refs: { type: "array", items: { type: "string" } } },
  },
};

export const analysisSchema: Json = {
  type: "object",
  additionalProperties: false,
  required: ["observed_facts", "failure_hypothesis", "confidence", "evidence", "recommendations", "recommended_next_experiment", "limitations"],
  properties: {
    observed_facts: evidenceSchema,
    failure_hypothesis: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence: evidenceSchema,
    recommendations: { type: "array", items: { type: "string" } },
    recommended_next_experiment: { type: "string" },
    limitations: { type: "array", items: { type: "string" } },
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, field: string, errors: string[], { allowEmpty = false } = {}): string {
  if (typeof v !== "string") {
    errors.push(`${field} must be a string`);
    return "";
  }
  const s = v.trim();
  if (!allowEmpty && !s) errors.push(`${field} must not be empty`);
  if (s.length > MAX_TEXT) errors.push(`${field} is longer than ${MAX_TEXT} characters`);
  return s;
}

const REF = /\bS\d+\b/g;

const asList = (v: unknown): unknown => (typeof v === "string" && v.trim() ? [v] : v);

function textList(v: unknown, field: string, errors: string[], min = 0): string[] {
  v = asList(v);
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (v.length < min) errors.push(`${field} needs at least ${min} item(s)`);
  if (v.length > MAX_ITEMS) errors.push(`${field} has more than ${MAX_ITEMS} items`);
  return v.slice(0, MAX_ITEMS).map((x, i) => text(x, `${field}[${i}]`, errors));
}

function evidenceList(v: unknown, field: string, refs: Set<string>, errors: string[], min: number): EvidenceItem[] {
  v = asList(v);
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (v.length < min) errors.push(`${field} needs at least ${min} item(s)`);
  if (v.length > MAX_ITEMS) errors.push(`${field} has more than ${MAX_ITEMS} items`);
  return v.slice(0, MAX_ITEMS).map((raw, i) => {
    const item = typeof raw === "string" ? { statement: raw } : raw;
    if (!isRecord(item)) {
      errors.push(`${field}[${i}] must be an object`);
      return { statement: "", result_refs: [] };
    }
    const statement = text(item.statement, `${field}[${i}].statement`, errors);
    const listed = Array.isArray(item.result_refs) ? item.result_refs.filter((r): r is string => typeof r === "string") : [];
    const result_refs = [...new Set(listed.length ? listed : statement.match(REF) ?? [])];
    if (result_refs.length === 0) errors.push(`${field}[${i}] must cite at least one simulation result`);
    for (const r of result_refs) {
      if (!refs.has(r)) errors.push(`${field}[${i}] cites unknown or unexecuted simulation ${JSON.stringify(r)}`);
    }
    return { statement, result_refs };
  });
}

export function validateAnalysis(data: unknown, executedRefs: string[]): Validated<Analysis> {
  const errors: string[] = [];
  if (!isRecord(data)) return { ok: false, errors: ["analysis must be a JSON object"] };
  const refs = new Set(executedRefs);
  const confidence = data.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    errors.push("confidence must be low, medium or high");
  }
  const value: Analysis = {
    observed_facts: evidenceList(data.observed_facts, "observed_facts", refs, errors, 1),
    failure_hypothesis: text(data.failure_hypothesis, "failure_hypothesis", errors),
    confidence: confidence as Analysis["confidence"],
    evidence: evidenceList(data.evidence, "evidence", refs, errors, 1),
    recommendations: textList(data.recommendations, "recommendations", errors),
    recommended_next_experiment: text(data.recommended_next_experiment, "recommended_next_experiment", errors),
    limitations: textList(data.limitations, "limitations", errors),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export interface RawProposal {
  name: string;
  hypothesis: string;
  prediction: string;
  predicted_outcome: Outcome | null;
  rationale: string;
  overrides: Params;
}

export function proposalSchema(space: ParameterSpace): Json {
  const paramProps: Record<string, Json> = {};
  for (const [name, spec] of Object.entries(space.parameters)) {
    paramProps[name] = spec.type === "enum"
      ? { anyOf: [{ type: "string", enum: spec.values ?? [] }, { type: "null" }] }
      : { type: ["number", "null"] };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposed_scenarios"],
    properties: {
      proposed_scenarios: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "hypothesis", "prediction", "predicted_outcome", "rationale", "parameters"],
          properties: {
            name: { type: "string" },
            hypothesis: { type: "string" },
            prediction: { type: "string" },
            predicted_outcome: { type: "string", enum: [...OUTCOMES] },
            rationale: { type: "string" },
            parameters: {
              type: "object",
              additionalProperties: false,
              required: Object.keys(space.parameters),
              properties: paramProps,
            },
          },
        },
      },
    },
  };
}

export function validateProposals(
  data: unknown,
  space: ParameterSpace,
  maxCount: number,
): { valid: RawProposal[]; rejected: { proposal: Json; errors: string[] }[]; errors: string[] } {
  const list = Array.isArray(data)
    ? data
    : isRecord(data)
    ? [data.proposed_scenarios, data.scenarios, data.proposals].find(Array.isArray)
    : undefined;
  if (!list) {
    const got = isRecord(data) ? `object with keys [${Object.keys(data).slice(0, 8).join(", ")}]` : typeof data;
    return { valid: [], rejected: [], errors: [`response must be an object with a proposed_scenarios array (got ${got})`] };
  }
  const valid: RawProposal[] = [];
  const rejected: { proposal: Json; errors: string[] }[] = [];
  for (const raw of list.slice(0, MAX_ITEMS)) {
    const errors: string[] = [];
    if (!isRecord(raw)) {
      rejected.push({ proposal: raw as Json, errors: ["proposal must be an object"] });
      continue;
    }
    const name = cleanName(text(raw.name, "name", errors));
    const hypothesis = text(raw.hypothesis, "hypothesis", errors);
    const prediction = text(raw.prediction, "prediction", errors);
    const rationale = text(raw.rationale, "rationale", errors, { allowEmpty: true });
    const predicted = typeof raw.predicted_outcome === "string" ? raw.predicted_outcome.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    const predicted_outcome = (OUTCOMES as readonly string[]).includes(predicted) ? (predicted as Outcome) : null;
    const overrides: Params = {};
    if (!isRecord(raw.parameters)) {
      errors.push("parameters must be an object");
    } else {
      for (const [key, value] of Object.entries(raw.parameters)) {
        const spec = space.parameters[key];
        if (!spec) {
          errors.push(`unsupported parameter: ${key}`);
          continue;
        }
        if (value === null || value === undefined) continue;
        if (spec.type === "enum") {
          if (typeof value !== "string" || !(spec.values ?? []).includes(value)) {
            errors.push(`${key} must be one of ${(spec.values ?? []).join(", ")}`);
          } else overrides[key] = value;
        } else if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`${key} must be a finite number`);
        } else if (value < (spec.min ?? -Infinity) || value > (spec.max ?? Infinity)) {
          errors.push(`${key}=${value} is out of range [${spec.min}, ${spec.max}]`);
        } else overrides[key] = value;
      }
    }
    if (errors.length) rejected.push({ proposal: raw as Json, errors });
    else valid.push({ name, hypothesis, prediction, predicted_outcome, rationale, overrides });
  }
  for (const extra of valid.splice(maxCount)) {
    rejected.push({ proposal: extra as unknown as Json, errors: ["over the per-iteration scenario budget"] });
  }
  return { valid, rejected, errors: [] };
}

export const OUTCOMES = ["success", "collision", "no_path", "timeout", "stuck"] as const;

export function cleanName(name: string): string {
  const cleaned = name
    .replace(/^(?:(?:[ST]|run|test|scenario)\s*#?\d+|#?\d+)\s*[-_.:)\]]*\s*/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name;
}

export function paramsKey(p: Params): string {
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, typeof p[k] === "number" ? Math.round((p[k] as number) * 100) / 100 : p[k]]));
}
