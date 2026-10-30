"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Params } from "@/lib/experiments";
import { robotPoseAt } from "@/lib/playback";
import type { Replay, ReplayIndexEntry, SimulationResult } from "@/lib/replay";
import { listReplays, loadReplay } from "@/lib/replaySource";
import type { CameraMode } from "./WarehouseScene";
import AiPanel from "./AiPanel";
import styles from "./ReplayViewer.module.css";

const WarehouseScene = dynamic(() => import("./WarehouseScene"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading 3D scene…</div>,
});

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const PANEL_DEFAULT = 340;
const PANEL_MIN = 300;
const STAGE_MIN = 320;
const PANEL_KEY = "worldforge.panelWidth";
const FAILURE_LEAD_IN = 2.5;

const METRICS: Record<string, { label: string; help: string }> = {
  distance_travelled: { label: "Distance travelled", help: "Total distance the robot moved, in sim units (1 unit = 1 cm)." },
  straight_line_distance: { label: "Straight-line distance", help: "Start-to-goal distance ignoring obstacles." },
  goal_progress: {
    label: "Goal progress",
    help: "Share of the start-to-goal straight-line gap closed: 1 = at the goal, 0 = no closer than at the start.",
  },
  path_efficiency: {
    label: "Path efficiency",
    help: "Straight-line ÷ travelled distance. Only defined for successful runs (— otherwise).",
  },
  min_clearance: {
    label: "Min clearance",
    help: "Smallest gap between the robot's edge and any obstacle. Positive = separated, 0 = touching, negative = overlapping by that many units.",
  },
  final_distance_to_goal: { label: "Final distance to goal", help: "Distance from the robot's last position to the goal." },
  planned_path_length: { label: "Planned path length", help: "Length of the initial A* path (— if none was found)." },
  replan_count: { label: "Replans", help: "Times the controller re-ran A* after being blocked." },
  wait_steps: { label: "Wait steps", help: "Steps where the robot did not move forward." },
};

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  const s = Number.isInteger(v) ? String(v) : v.toFixed(digits);
  return s.replace(/^-/, "−");
}

function titleCase(id: string): string {
  return id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function headline(replay: Replay): string {
  const r = replay.result;
  const c = r.collision;
  switch (r.outcome) {
    case "success":
      return `Robot reached the goal at ${fmt(r.duration)} s.`;
    case "collision": {
      if (!c) return r.reason;
      if (c.obstacle_id === "wall") return `Robot hit the warehouse boundary at ${fmt(c.t)} s.`;
      const moving = replay.moving_obstacle_tracks.some((t) => t.id === c.obstacle_id);
      return moving
        ? `${titleCase(c.obstacle_id)} collided with the robot at ${fmt(c.t)} s.`
        : `Robot collided with ${c.obstacle_id} at ${fmt(c.t)} s.`;
    }
    case "no_path":
      return "Goal is unreachable. The robot never moved.";
    default:
      return r.reason.charAt(0).toUpperCase() + r.reason.slice(1) + ".";
  }
}

function explanation(replay: Replay): string | null {
  const r = replay.result;
  if (r.outcome === "success") return null;
  if (r.outcome === "no_path") return r.diagnostics?.message ?? r.reason;
  if (r.outcome === "collision" && replay.scenario.failure_explanation) return replay.scenario.failure_explanation;
  return r.reason;
}

function keyStats(r: SimulationResult): { label: string; value: string; note?: string }[] {
  const m = r.metrics;
  const base = [
    { label: "Duration", value: `${fmt(r.duration)} s` },
    { label: "Distance", value: fmt(m.distance_travelled, 0) },
  ];
  if (r.outcome === "success") return [...base, { label: "Path efficiency", value: fmt(m.path_efficiency) }];
  if (r.outcome === "no_path")
    return [...base, { label: "Blocking obstacles", value: String(r.diagnostics?.blocking_obstacle_ids?.length ?? "—") }];
  const clearance = m.min_clearance;
  return [
    ...base,
    {
      label: "Min clearance",
      value: fmt(clearance, 1),
      note: clearance !== null && clearance !== undefined && clearance < 0 ? "overlap" : undefined,
    },
    { label: "Goal progress", value: m.goal_progress === null || m.goal_progress === undefined ? "—" : `${Math.round(m.goal_progress * 100)}%` },
  ];
}

export default function ReplayViewer() {
  const [entries, setEntries] = useState<ReplayIndexEntry[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [replay, setReplay] = useState<Replay | null>(null);
  const [external, setExternal] = useState<{ label: string; params: Params } | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [tab, setTab] = useState<"result" | "ai">("result");
  const [error, setError] = useState<string | null>(null);

  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>("overview");
  const [cameraReset, setCameraReset] = useState(0);

  const mainRef = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [resizing, setResizing] = useState(false);

  const clampPanel = useCallback((w: number) => {
    const total = mainRef.current?.clientWidth ?? 0;
    const max = Math.max(PANEL_MIN, total - STAGE_MIN);
    return Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
  }, []);

  const resizePanel = useCallback(
    (w: number) => {
      const next = clampPanel(w);
      setPanelWidth(next);
      try {
        localStorage.setItem(PANEL_KEY, String(next));
      } catch {}
    },
    [clampPanel],
  );

  useEffect(() => {
    let saved = NaN;
    try {
      saved = Number(localStorage.getItem(PANEL_KEY));
    } catch {}
    const frame = requestAnimationFrame(() => {
      if (saved > 0) setPanelWidth(clampPanel(saved));
    });
    const onResize = () => setPanelWidth((w) => clampPanel(w));
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [clampPanel]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing || !mainRef.current) return;
    resizePanel(mainRef.current.getBoundingClientRect().right - e.clientX);
  };
  const endResize = () => setResizing(false);
  const keyResize = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft") resizePanel(panelWidth + step);
    else if (e.key === "ArrowRight") resizePanel(panelWidth - step);
    else if (e.key === "Home") resizePanel(Number.MAX_SAFE_INTEGER);
    else if (e.key === "End") resizePanel(PANEL_MIN);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const seek = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
  }, []);

  const chooseCamera = useCallback((mode: CameraMode) => {
    setCameraMode(mode);
    setCameraReset((k) => k + 1);
  }, []);

  useEffect(() => {
    listReplays()
      .then((list) => {
        setEntries(list);
        const fromUrl = new URLSearchParams(window.location.search).get("replay");
        setSelected(list.find((e) => e.id === fromUrl)?.id ?? list[0]?.id ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    loadReplay(selected)
      .then((r) => {
        if (cancelled) return;
        setReplay(r);
        seek(0);
        setPlaying(true);
        chooseCamera("overview");
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    const url = new URL(window.location.href);
    url.searchParams.set("replay", selected);
    window.history.replaceState(null, "", url);
    return () => {
      cancelled = true;
    };
  }, [selected, loadKey, seek, chooseCamera]);

  const duration = replay?.result.duration ?? 0;
  const collision = replay?.result.collision ?? null;

  const isPlaying = playing && !!replay && time < duration;
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(timeRef.current + ((now - last) / 1000) * speedRef.current, duration);
      last = now;
      seek(next);
      if (next >= duration) {
        setPlaying(false);
        if (collision) chooseCamera("collision");
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, duration, collision, seek, chooseCamera]);

  const restart = useCallback(() => {
    seek(0);
    setPlaying(true);
  }, [seek]);

  const togglePlay = useCallback(() => {
    if (timeRef.current >= duration) restart();
    else setPlaying((p) => !p);
  }, [duration, restart]);

  const replayFailure = useCallback(() => {
    if (!collision) return;
    seek(Math.max(0, collision.t - FAILURE_LEAD_IN));
    setSpeed(0.5);
    chooseCamera("follow");
    setPlaying(true);
  }, [collision, seek, chooseCamera]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "r" || e.key === "R") restart();
      else if (e.key === "o" || e.key === "O") chooseCamera("overview");
      else if (e.key === "f" || e.key === "F") chooseCamera("follow");
      else if ((e.key === "c" || e.key === "C") && collision) chooseCamera("collision");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, restart, chooseCamera, collision]);

  if (error) return <div className={styles.error}>Could not load replay data: {error}</div>;

  const result = replay?.result;
  const finished = !!result && time >= duration;
  const step = result ? robotPoseAt(result.trajectory, time).index : 0;
  const status = result?.trajectory[step]?.status ?? "";
  const noPath = result?.outcome === "no_path";
  const why = replay ? explanation(replay) : null;
  const atCollision = finished && !!collision;

  return (
    <div className={styles.shell}>
      <header className={styles.toolbar}>
        <Link href="/" className={styles.brand}>
          WorldForge <span>3D replay</span>
        </Link>
        <label className={styles.field}>
          <span>Replay</span>
          <select
            value={external ? "__external" : selected}
            onChange={(e) => {
              setExternal(null);
              setSelected(e.target.value);
              setLoadKey((k) => k + 1);
            }}
          >
            {external && <option value="__external">{external.label}</option>}
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} ({e.outcome})
              </option>
            ))}
          </select>
        </label>
        <div className={styles.group}>
          <button onClick={togglePlay} disabled={!replay || noPath} className={styles.primary}>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button onClick={restart} disabled={!replay || noPath}>
            Restart
          </button>
          {collision && (
            <button onClick={replayFailure} className={styles.danger}>
              Replay failure
            </button>
          )}
        </div>
        <label className={styles.field}>
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <div className={styles.group} role="group" aria-label="Camera">
          <button className={cameraMode === "overview" ? styles.active : ""} onClick={() => chooseCamera("overview")}>
            Overview
          </button>
          <button
            className={cameraMode === "follow" ? styles.active : ""}
            onClick={() => chooseCamera("follow")}
            disabled={noPath}
          >
            Follow robot
          </button>
          <button
            className={cameraMode === "collision" ? styles.active : ""}
            onClick={() => chooseCamera("collision")}
            disabled={!collision}
          >
            Collision view
          </button>
        </div>
      </header>

      <main
        ref={mainRef}
        className={`${styles.main} ${resizing ? styles.resizing : ""}`}
        style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}
      >
        <section className={styles.stage}>
          {replay ? (
            <WarehouseScene replay={replay} time={time} cameraMode={cameraMode} resetKey={cameraReset} />
          ) : (
            <div className={styles.loading}>Loading replay…</div>
          )}
          {atCollision && collision && (
            <div className={styles.banner}>
              Paused at collision · t = {fmt(collision.t)} s
            </div>
          )}
          {result && !noPath && (
            <div className={styles.timeline}>
              <span className={styles.clock}>
                t = {time.toFixed(2)} s <em>/ {duration.toFixed(2)} s</em>
              </span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={replay.scenario.dt / 4}
                value={time}
                onChange={(e) => {
                  setPlaying(false);
                  seek(Number(e.target.value));
                }}
                aria-label="Simulation time"
              />
              <span className={styles.step}>
                step {step}/{result.steps} · {status}
              </span>
            </div>
          )}
        </section>

        <div
          className={styles.divider}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize results panel"
          aria-valuemin={PANEL_MIN}
          aria-valuenow={panelWidth}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => resizePanel(PANEL_DEFAULT)}
          onKeyDown={keyResize}
        >
          <span />
        </div>

        <aside className={styles.panel}>
          <div className={styles.tabs} role="tablist">
            <button role="tab" aria-selected={tab === "result"} className={tab === "result" ? styles.tabOn : ""} onClick={() => setTab("result")}>
              Result
            </button>
            <button role="tab" aria-selected={tab === "ai"} className={tab === "ai" ? styles.tabOn : ""} onClick={() => setTab("ai")}>
              AI · Nemotron
            </button>
          </div>
          <div hidden={tab !== "ai"}>
            <AiPanel
              baselineParams={external ? external.params : selected === "failure" ? {} : null}
              onResume={() => setTab("ai")}
              onReplay={(doc, label, params) => {
                setExternal({ label, params });
                setReplay(doc);
                seek(0);
                setPlaying(true);
                chooseCamera("overview");
              }}
            />
          </div>
          <div hidden={tab !== "result"}>
          {replay && result ? (
            <>
              <div className={styles.scenarioHead}>
                <span className={styles.scenarioName}>{replay.scenario.id}</span>
                <span className={styles.muted}>seed {result.seed}</span>
              </div>
              <p className={styles.muted}>{replay.scenario.description}</p>

              <h3 className={styles.sectionTitle}>Simulation result</h3>
              <div className={`${styles.resultCard} ${finished ? styles[`r_${result.outcome}`] ?? "" : ""}`}>
                {finished ? (
                  <>
                    <div className={styles.outcome}>{result.outcome.replace("_", " ")}</div>
                    <p className={styles.headline}>{headline(replay)}</p>
                  </>
                ) : (
                  <div className={styles.running}>Replaying… t = {time.toFixed(2)} s</div>
                )}
                {finished && <dl className={styles.keyStats}>
                  {keyStats(result).map((s) => (
                    <div key={s.label}>
                      <dt>{s.label}</dt>
                      <dd>
                        {s.value}
                        {s.note && <small> {s.note}</small>}
                      </dd>
                    </div>
                  ))}
                </dl>}
              </div>

              {collision && finished && (
                <>
                  <h3 className={styles.sectionTitle}>Collision</h3>
                  <dl className={styles.facts}>
                    <dt>Obstacle</dt>
                    <dd>{collision.obstacle_id}</dd>
                    <dt>Time</dt>
                    <dd>
                      {fmt(collision.t)} s · step {collision.step}
                    </dd>
                    <dt>Position</dt>
                    <dd>
                      ({fmt(collision.x, 1)}, {fmt(collision.y, 1)})
                    </dd>
                  </dl>
                </>
              )}

              {noPath && result.diagnostics?.blocking_obstacle_ids && (
                <>
                  <h3 className={styles.sectionTitle}>Blocking obstacles</h3>
                  <p className={styles.chips}>
                    {result.diagnostics.blocking_obstacle_ids.map((id) => (
                      <span key={id}>{id}</span>
                    ))}
                  </p>
                </>
              )}

              {why && finished && (
                <>
                  <h3 className={styles.sectionTitle}>{noPath ? "Why no route" : "Failure explanation"}</h3>
                  <p className={styles.explanation}>{why}</p>
                </>
              )}

              <details className={styles.details}>
                <summary>Detailed metrics</summary>
                <dl className={styles.metrics}>
                  {Object.entries(result.metrics).map(([k, v]) => (
                    <div key={k} title={METRICS[k]?.help}>
                      <dt>{METRICS[k]?.label ?? k}</dt>
                      <dd>{fmt(v)}</dd>
                    </div>
                  ))}
                </dl>
                <ul className={styles.definitions}>
                  {Object.keys(result.metrics)
                    .filter((k) => METRICS[k])
                    .map((k) => (
                      <li key={k}>
                        <b>{METRICS[k].label}:</b> {METRICS[k].help}
                      </li>
                    ))}
                </ul>
              </details>

              <details className={styles.details}>
                <summary>Legend &amp; shortcuts</summary>
                <ul className={styles.legend}>
                  <li><i style={{ background: "#4a78dc" }} />Planned path (A*)</li>
                  <li><i style={{ background: "#14aabe" }} />Recorded trajectory</li>
                  <li><i style={{ background: "#e67e22" }} />Moving obstacle</li>
                  <li><i style={{ background: "#2fa05a" }} />Start · <i style={{ background: "#c8323c" }} />Goal</li>
                  <li><i style={{ background: "#ff2a2a" }} />Recorded collision / colliding obstacle</li>
                  <li><i style={{ background: "#8b3fd6" }} />Unreachable goal / blocking obstacles</li>
                </ul>
                <p className={styles.hint}>Space play/pause · R restart · O overview · F follow · C collision view · drag to orbit</p>
              </details>
            </>
          ) : (
            <div className={styles.muted}>Loading…</div>
          )}
          </div>
        </aside>
      </main>
    </div>
  );
}
