import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.0";

import type { AnalysisRow, Experiment, ExperimentStatus, SimulationRow } from "./types.ts";

export type NewExperiment = Omit<
  Experiment,
  "id" | "created_at" | "updated_at" | "status" | "phase" | "completed_simulations" | "model_calls" | "current_iteration" | "error" | "error_count" | "lock_until" | "comparison"
>;
export type ExperimentPatch = Partial<Omit<Experiment, "id" | "created_at">>;
export type NewSimulation = Omit<SimulationRow, "id" | "created_at">;
export type NewAnalysis = Omit<AnalysisRow, "id" | "created_at">;

export interface Store {
  createExperiment(e: NewExperiment): Promise<Experiment>;
  getExperiment(id: string): Promise<Experiment | null>;
  updateExperiment(id: string, patch: ExperimentPatch, onlyIfStatus?: ExperimentStatus): Promise<Experiment | null>;
  acquireLock(id: string, ms: number): Promise<Experiment | null>;
  releaseLock(id: string): Promise<void>;
  countExperiments(opts: { status?: ExperimentStatus; since?: string }): Promise<number>;
  insertSimulation(row: NewSimulation): Promise<SimulationRow>;
  listSimulations(experimentId: string, opts?: { heavy?: boolean }): Promise<SimulationRow[]>;
  getSimulation(experimentId: string, id: string): Promise<SimulationRow | null>;
  insertAnalysis(row: NewAnalysis): Promise<AnalysisRow>;
  listAnalyses(experimentId: string): Promise<AnalysisRow[]>;
}

const EXPERIMENT_DEFAULTS = {
  status: "running" as const,
  phase: "baseline" as const,
  completed_simulations: 0,
  model_calls: 0,
  current_iteration: 0,
  error: null,
  error_count: 0,
  lock_until: null,
  comparison: null,
};

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  experiments = new Map<string, Experiment>();
  simulations: SimulationRow[] = [];
  analyses: AnalysisRow[] = [];
  constructor(private now: () => Date = () => new Date()) {}

  createExperiment(e: NewExperiment) {
    const t = this.now().toISOString();
    const row: Experiment = { ...clone(e), ...EXPERIMENT_DEFAULTS, id: crypto.randomUUID(), created_at: t, updated_at: t };
    this.experiments.set(row.id, row);
    return Promise.resolve(clone(row));
  }
  getExperiment(id: string) {
    const e = this.experiments.get(id);
    return Promise.resolve(e ? clone(e) : null);
  }
  updateExperiment(id: string, patch: ExperimentPatch, onlyIfStatus?: ExperimentStatus) {
    const e = this.experiments.get(id);
    if (!e || (onlyIfStatus && e.status !== onlyIfStatus)) return Promise.resolve(null);
    Object.assign(e, clone(patch), { updated_at: this.now().toISOString() });
    return Promise.resolve(clone(e));
  }
  acquireLock(id: string, ms: number) {
    const e = this.experiments.get(id);
    const now = this.now();
    if (!e || e.status !== "running" || (e.lock_until && new Date(e.lock_until) > now)) return Promise.resolve(null);
    e.lock_until = new Date(now.getTime() + ms).toISOString();
    return Promise.resolve(clone(e));
  }
  releaseLock(id: string) {
    const e = this.experiments.get(id);
    if (e) e.lock_until = null;
    return Promise.resolve();
  }
  countExperiments({ status, since }: { status?: ExperimentStatus; since?: string }) {
    let n = 0;
    for (const e of this.experiments.values()) {
      if (status && e.status !== status) continue;
      if (since && e.created_at < since) continue;
      n++;
    }
    return Promise.resolve(n);
  }
  insertSimulation(row: NewSimulation) {
    if (this.simulations.some((s) => s.experiment_id === row.experiment_id && s.seq === row.seq)) {
      return Promise.reject(new Error("duplicate simulation seq"));
    }
    const r: SimulationRow = { ...clone(row), id: crypto.randomUUID(), created_at: this.now().toISOString() };
    this.simulations.push(r);
    return Promise.resolve(clone(r));
  }
  listSimulations(experimentId: string, opts: { heavy?: boolean } = {}) {
    const rows = this.simulations.filter((s) => s.experiment_id === experimentId).sort((a, b) => a.seq - b.seq).map(clone);
    if (!opts.heavy) for (const r of rows) Object.assign(r, { replay: null, trajectory: null });
    return Promise.resolve(rows);
  }
  getSimulation(experimentId: string, id: string) {
    const r = this.simulations.find((s) => s.experiment_id === experimentId && s.id === id);
    return Promise.resolve(r ? clone(r) : null);
  }
  insertAnalysis(row: NewAnalysis) {
    const r: AnalysisRow = { ...clone(row), id: crypto.randomUUID(), created_at: this.now().toISOString() };
    this.analyses.push(r);
    return Promise.resolve(clone(r));
  }
  listAnalyses(experimentId: string) {
    return Promise.resolve(this.analyses.filter((a) => a.experiment_id === experimentId).map(clone));
  }
}

const LIGHT_SIM_COLUMNS =
  "id,experiment_id,seq,arm,iteration,proposal_index,name,hypothesis,scenario_id,seed,params,scenario_config,outcome,failure_type,reason,metrics,collision,created_at";

export class SupabaseStore implements Store {
  private db: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private check<T>(res: { data: T; error: { message: string; code?: string } | null; status?: number }): T {
    if (res.error) throw new Error(`database error: ${res.error.message || res.error.code || `HTTP ${res.status}`}`);
    return res.data;
  }

  async createExperiment(e: NewExperiment) {
    return this.check(await this.db.from("experiments").insert(e).select().single()) as Experiment;
  }
  async getExperiment(id: string) {
    return this.check(await this.db.from("experiments").select().eq("id", id).maybeSingle()) as Experiment | null;
  }
  async updateExperiment(id: string, patch: ExperimentPatch, onlyIfStatus?: ExperimentStatus) {
    let q = this.db.from("experiments").update(patch).eq("id", id);
    if (onlyIfStatus) q = q.eq("status", onlyIfStatus);
    return this.check(await q.select().maybeSingle()) as Experiment | null;
  }
  async acquireLock(id: string, ms: number) {
    const now = new Date();
    const res = await this.db
      .from("experiments")
      .update({ lock_until: new Date(now.getTime() + ms).toISOString() })
      .eq("id", id)
      .eq("status", "running")
      .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
      .select()
      .maybeSingle();
    return this.check(res) as Experiment | null;
  }
  async releaseLock(id: string) {
    this.check(await this.db.from("experiments").update({ lock_until: null }).eq("id", id));
  }
  async countExperiments({ status, since }: { status?: ExperimentStatus; since?: string }) {
    let q = this.db.from("experiments").select("id", { count: "exact", head: true });
    if (status) q = q.eq("status", status);
    if (since) q = q.gte("created_at", since);
    const res = await q;
    if (res.error) throw new Error(`database error: ${res.error.message || res.error.code || `HTTP ${res.status}`}`);
    return res.count ?? 0;
  }
  async insertSimulation(row: NewSimulation) {
    return this.check(await this.db.from("simulation_results").insert(row).select(LIGHT_SIM_COLUMNS).single()) as unknown as SimulationRow;
  }
  async listSimulations(experimentId: string, opts: { heavy?: boolean } = {}) {
    const cols = opts.heavy ? "*" : LIGHT_SIM_COLUMNS;
    return this.check(await this.db.from("simulation_results").select(cols).eq("experiment_id", experimentId).order("seq")) as unknown as SimulationRow[];
  }
  async getSimulation(experimentId: string, id: string) {
    return this.check(
      await this.db.from("simulation_results").select().eq("experiment_id", experimentId).eq("id", id).maybeSingle(),
    ) as SimulationRow | null;
  }
  async insertAnalysis(row: NewAnalysis) {
    return this.check(await this.db.from("ai_analyses").insert(row).select().single()) as AnalysisRow;
  }
  async listAnalyses(experimentId: string) {
    return this.check(await this.db.from("ai_analyses").select().eq("experiment_id", experimentId).order("created_at")) as AnalysisRow[];
  }
}
