import type { TrackSample, TrajectoryPoint } from "./replay";

export function indexAt(samples: { t: number }[], time: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  if (hi < 0 || time <= samples[0].t) return 0;
  if (time >= samples[hi].t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function fraction(a: { t: number }, b: { t: number }, time: number): number {
  const span = b.t - a.t;
  return span > 0 ? Math.min(1, Math.max(0, (time - a.t) / span)) : 0;
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * f;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
  index: number;
}

export function robotPoseAt(trajectory: TrajectoryPoint[], time: number): Pose {
  const i = indexAt(trajectory, time);
  const a = trajectory[i];
  const b = trajectory[Math.min(i + 1, trajectory.length - 1)];
  const f = fraction(a, b, time);
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    heading: lerpAngle(a.heading, b.heading, f),
    index: i,
  };
}

export function trackPositionAt(samples: TrackSample[], time: number): { x: number; y: number } {
  const i = indexAt(samples, time);
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  const f = fraction(a, b, time);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
