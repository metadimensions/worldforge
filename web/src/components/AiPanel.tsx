"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  aiConfigured,
  api,
  ApiError,
  type Analysis,
  type ArmStats,
  displayName,
  type ExperimentView,
  type Params,
  PHASE_LABELS,
  predictedOutcome,
  ref,
  type SimulationSummary,
} from "@/lib/experiments";
import type { Replay } from "@/lib/replay";
import styles from "./AiPanel.module.css";

interface Props {
  baselineParams: Params | null;
  onReplay: (replay: Replay, label: string, params: Params) => void;
  onResume?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readExperimentFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("experiment");
}

function writeExperimentToUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("experiment", id);
  else url.searchParams.delete("experiment");
  window.history.replaceState(null, "", url);
}

function changed(params: Params, baseline: Params): [string, string | number][] {
  return Object.entries(params).filter(([k, v]) => baseline[k] !== v).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]);
}

export default function AiPanel({ baselineParams, onReplay, onResume }: Props) {
  const [view, setView] = useState<ExperimentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [loadingReplay, setLoadingReplay] = useState<string | null>(null);
  const driving = useRef<string | null>(null);

  const drive = useCallback(async (id: string) => {
    if (driving.current === id) return;
    driving.current = id;
    let failures = 0;
    try {
      while (driving.current === id) {
        try {
          const v = await api.advance(id);
          setView(v);
          setError(null);
          failures = 0;
          if (v.experiment.status !== "running") break;
          await sleep(v.step === "busy" ? 2000 : 250);
        } catch (e) {
          failures++;
          setError(`${(e as Error).message}${failures < 5 ? " — retrying…" : ""}`);
          if (failures >= 5) break;
          await sleep(1500 * failures);
        }
      }
    } finally {
      if (driving.current === id) driving.current = null;
    }
  }, []);

  useEffect(() => {
    const id = readExperimentFromUrl();
    if (!id || !aiConfigured) return;
    api
      .get(id)
      .then((v) => {
        setView(v);
        onResume?.();
        if (v.experiment.status === "running") void drive(id);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      driving.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive]);

  const start = async () => {
    if (!baselineParams) return;
    setStarting(true);
    setError(null);
    try {
      const v = await api.start(baselineParams, code || undefined);
      setNeedsCode(false);
      setView(v);
      writeExperimentToUrl(v.experiment.id);
      void drive(v.experiment.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsCode(true);
      const details = e instanceof ApiError && e.details.length ? ` (${e.details.join("; ")})` : "";
      setError(`${(e as Error).message}${details}`);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!view) return;
    driving.current = null;
    try {
      setView(await api.stop(view.experiment.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reset = () => {
    driving.current = null;
    setView(null);
    setError(null);
    writeExperimentToUrl(null);
  };

  const replay = async (s: SimulationSummary) => {
    if (!view) return;
    setLoadingReplay(s.id);
    try {
      const doc = await api.replay(view.experiment.id, s.id);
      onReplay(doc, `${ref(s)} · ${displayName(s.name) || s.arm} (${s.outcome})`, s.params);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingReplay(null);
    }
  };

  if (!aiConfigured) {
    return (
      <section className={styles.panel}>
        <Header />
        <p className={styles.muted}>
          AI-guided testing needs the Supabase backend. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (see README).
        </p>
      </section>
    );
  }

  const exp = view?.experiment;
  const running = exp?.status === "running";
  const sims = view?.simulations ?? [];
  const byId = new Map(sims.map((s) => [ref(s), s]));
  const analyses = (view?.analyses ?? []).filter((a) => a.kind === "analysis");
  const latest = analyses.at(-1) ?? null;
  const proposalRows = (view?.analyses ?? []).filter((a) => a.kind === "proposal");
  const baseline = exp?.initial_scenario ?? baselineParams ?? {};

  const ReplayButton = ({ s }: { s: SimulationSummary }) => (
    <button className={styles.link} onClick={() => replay(s)} disabled={loadingReplay === s.id}>
      {loadingReplay === s.id ? "Loading…" : "Replay"}
    </button>
  );

  const Refs = ({ refs }: { refs: string[] }) => (
    <span className={styles.refs}>
      {refs.map((r) => {
        const s = byId.get(r);
        return s ? (
          <button key={r} className={styles.refChip} onClick={() => replay(s)} title={`Replay ${r}`}>
            {r}
          </button>
        ) : (
          <span key={r} className={styles.refChip}>{r}</span>
        );
      })}
    </span>
  );

  return (
    <section className={styles.panel}>
      <Header model={exp?.model_id} />

      {!view && (
        <>
          <p className={styles.muted}>
            Nemotron analyses this run&apos;s actual simulation data, proposes targeted scenarios, and WorldForge executes
            them in the Python simulator — then compares the discoveries with random testing on the same budget.
          </p>
          {needsCode && (
            <input className={styles.code} placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} />
          )}
          <button className={styles.primary} onClick={start} disabled={!baselineParams || starting}>
            {starting ? "Starting…" : "Run AI-guided tests"}
          </button>
          {!baselineParams && (
            <p className={styles.hint}>Select the <b>failure</b> replay (forklift crossing) or an AI-generated run to start from.</p>
          )}
        </>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {view && exp && (
        <>
          <div className={styles.progress}>
            <div className={styles.progressHead}>
              <span className={`${styles.status} ${styles[`s_${exp.status}`] ?? ""}`}>{exp.status}</span>
              <span>{running ? PHASE_LABELS[view.progress.phase] ?? view.progress.phase : exp.status === "completed" ? "Experiment complete" : exp.status}</span>
            </div>
            <div className={styles.bar}>
              <i style={{ width: `${Math.min(100, (100 * (view.progress.ai_simulations + view.progress.random_simulations)) / Math.max(1, 2 * view.progress.simulation_budget_per_arm - 1))}%` }} />
            </div>
            <dl className={styles.counters}>
              <div><dt>Iteration</dt><dd>{view.progress.iteration}/{view.progress.max_iterations}</dd></div>
              <div><dt>AI-arm sims</dt><dd>{view.progress.ai_simulations}/{view.progress.simulation_budget_per_arm}</dd></div>
              <div><dt>Random sims</dt><dd>{view.progress.random_simulations}</dd></div>
              <div><dt>Model calls</dt><dd>{view.progress.model_calls}/{view.progress.model_call_cap}</dd></div>
            </dl>
            {exp.error && <p className={styles.warn}>Last issue: {exp.error}</p>}
            <div className={styles.actions}>
              {running ? (
                <button onClick={stop}>Stop experiment</button>
              ) : (
                <button onClick={reset}>New experiment</button>
              )}
              <span className={styles.muted}>seed {exp.base_seed}</span>
            </div>
          </div>

          {latest && (
            <>
              <h4 className={styles.title}>Failure hypothesis <small>(AI · {latest.confidence} confidence)</small></h4>
              <p className={styles.hypothesis}>{latest.failure_hypothesis}</p>
              {latest.evidence && latest.evidence.length > 0 && (
                <>
                  <h4 className={styles.title}>Evidence from simulation</h4>
                  <ul className={styles.list}>
                    {latest.evidence.map((e, i) => (
                      <li key={i}>{e.statement} <Refs refs={e.result_refs} /></li>
                    ))}
                  </ul>
                </>
              )}
              <details className={styles.details}>
                <summary>Observed facts &amp; limitations</summary>
                <ul className={styles.list}>
                  {(latest.observed_facts ?? []).map((f, i) => (
                    <li key={i}>{f.statement} <Refs refs={f.result_refs} /></li>
                  ))}
                </ul>
                <ul className={styles.list}>
                  {(latest.limitations ?? []).map((l, i) => <li key={i} className={styles.muted}>{l}</li>)}
                </ul>
              </details>
              {latest.recommended_next_experiment && (
                <>
                  <h4 className={styles.title}>Recommended next experiment <small>(untested)</small></h4>
                  <p className={styles.next}>{latest.recommended_next_experiment}</p>
                </>
              )}
            </>
          )}

          {proposalRows.length > 0 && (
            <>
              <h4 className={styles.title}>Proposed experiments</h4>
              {proposalRows.map((p) => (
                <ProposalBatch key={p.id} batch={p} sims={sims} baseline={baseline} replayButton={ReplayButton} />
              ))}
            </>
          )}

          {sims.length > 0 && (
            <>
              <h4 className={styles.title}>All simulation results</h4>
              <table className={styles.table}>
                <tbody>
                  {sims.map((s) => (
                    <tr key={s.id}>
                      <td className={styles.ref}>{ref(s)}</td>
                      <td><span className={styles[`arm_${s.arm}`]}>{s.arm}</span></td>
                      <td className={styles.name} title={`${displayName(s.name)} — ${s.reason}`}>{displayName(s.name)}</td>
                      <td><Outcome outcome={s.outcome} /></td>
                      <td><ReplayButton s={s} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {(view.comparison.simulations_per_arm.ai > 0 || view.comparison.simulations_per_arm.random > 0) && (
            <ComparisonTable cmp={view.comparison} />
          )}
        </>
      )}
    </section>
  );
}

function Header({ model }: { model?: string }) {
  return (
    <div className={styles.header}>
      <span className={styles.badge}>AI</span>
      <div>
        <div className={styles.heading}>WorldForge AI — Nemotron</div>
        <div className={styles.muted}>{model ?? "NVIDIA Nemotron via Nebius Token Factory"}</div>
      </div>
    </div>
  );
}

function Outcome({ outcome }: { outcome: string }) {
  return <span className={`${styles.outcome} ${styles[`o_${outcome}`] ?? ""}`}>{outcome.replace("_", " ")}</span>;
}

function ProposalBatch({
  batch,
  sims,
  baseline,
  replayButton: ReplayButton,
}: {
  batch: Analysis;
  sims: SimulationSummary[];
  baseline: Params;
  replayButton: (p: { s: SimulationSummary }) => React.ReactElement;
}) {
  return (
    <div className={styles.batch}>
      <div className={styles.batchHead}>Iteration {batch.iteration}</div>
      {(batch.proposed_scenarios ?? []).map((p, i) => {
        const run = sims.find((s) => s.arm === "ai" && s.iteration === batch.iteration && s.proposal_index === i);
        return (
          <div key={i} className={styles.proposal}>
            <div className={styles.proposalHead}>
              <b className={styles.proposalName} title={displayName(p.name)}>{displayName(p.name)}</b>
              {run ? <Outcome outcome={run.outcome} /> : <span className={styles.pending}>not run yet</span>}
            </div>
            <p className={styles.small}>{p.hypothesis}</p>
            <p className={styles.small}>
              <span className={styles.label}>{run ? "Prediction:" : "Prediction (untested):"}</span> {p.prediction}
              {run && <Verdict predicted={predictedOutcome(p)} actual={run.outcome} />}
            </p>
            <p className={styles.chips}>
              {changed(p.params, baseline).map(([k, v]) => <span key={k}>{k} = {String(v)}</span>)}
              {changed(p.params, baseline).length === 0 && <span>baseline parameters</span>}
            </p>
            {run && (
              <p className={styles.small}>
                <span className={styles.label}>Actual result ({ref(run)}):</span> {run.reason}
                {run.failure_type && <> · <code>{run.failure_type}</code></>} <ReplayButton s={run} />
              </p>
            )}
          </div>
        );
      })}
      {(batch.rejected_proposals ?? []).length > 0 && (
        <details className={styles.details}>
          <summary>{batch.rejected_proposals!.length} proposal(s) rejected by validation</summary>
          <ul className={styles.list}>
            {batch.rejected_proposals!.map((r, i) => <li key={i} className={styles.muted}>{r.errors.join("; ")}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Verdict({ predicted, actual }: { predicted: { outcome: string; inferred: boolean } | null; actual: string }) {
  if (!predicted) return null;
  const held = predicted.outcome === actual;
  const note = `Predicted ${predicted.outcome.replace("_", " ")}${predicted.inferred ? " (read from the prediction text)" : ""}, actual ${actual.replace("_", " ")}`;
  return (
    <span className={`${styles.verdict} ${held ? styles.v_held : styles.v_wrong}`} title={note}>
      {held ? "✓ Prediction held" : "✗ Prediction wrong"}
    </span>
  );
}

function ComparisonTable({ cmp }: { cmp: ExperimentView["comparison"] }) {
  const rows: [string, (a: ArmStats) => string][] = [
    ["Simulations", (a) => String(a.total_simulations)],
    ["Failures found", (a) => String(a.failures)],
    ["Failure discovery rate", (a) => (a.failure_discovery_rate === null ? "—" : `${Math.round(a.failure_discovery_rate * 100)}%`)],
    ["Unique failure modes", (a) => String(a.unique_failure_modes.length)],
    ["Failure types not in baseline", (a) => String(a.new_failure_modes.length)],
    ["First failure at run #", (a) => (a.first_failure_at === null ? "—" : String(a.first_failure_at))],
    ["Collisions", (a) => String(a.outcomes.collision ?? 0)],
    ["No path", (a) => String(a.outcomes.no_path ?? 0)],
    ["Timeout / stuck", (a) => String((a.outcomes.timeout ?? 0) + (a.outcomes.stuck ?? 0))],
    ["Success", (a) => String(a.outcomes.success ?? 0)],
  ];
  return (
    <>
      <h4 className={styles.title}>AI-guided vs random testing</h4>
      <table className={styles.compare}>
        <thead>
          <tr><th /><th>Nemotron-guided</th><th>Random</th></tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}><td>{label}</td><td>{f(cmp.arms.ai)}</td><td>{f(cmp.arms.random)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className={styles.sample}>
        {Math.max(cmp.arms.ai.total_simulations, cmp.arms.random.total_simulations)} runs per arm — small sample
      </p>
      {[...new Set([...cmp.arms.ai.unique_failure_modes, ...cmp.arms.random.unique_failure_modes])].length > 0 && (
        <p className={styles.chips}>
          {[...new Set([...cmp.arms.ai.unique_failure_modes, ...cmp.arms.random.unique_failure_modes])].map((m) => <span key={m}>{m}</span>)}
        </p>
      )}
      <p className={styles.hint}>
        {cmp.summary} Exploration runs only — the shared baseline ({cmp.baseline?.failure_type ?? cmp.baseline?.outcome ?? "—"}) is excluded.
        Same parameter bounds and simulation budget for both arms; classifications come from the simulator output.
      </p>
    </>
  );
}
