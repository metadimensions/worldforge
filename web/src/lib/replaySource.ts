import type { Replay, ReplayIndexEntry } from "./replay";

const BASE = (process.env.NEXT_PUBLIC_REPLAY_BASE_URL ?? "/replays").replace(/\/$/, "");
const SUPPORTED_SCHEMA = 1;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return (await res.json()) as T;
}

export async function listReplays(): Promise<ReplayIndexEntry[]> {
  const index = await getJson<{ replays: ReplayIndexEntry[] }>(`${BASE}/index.json`);
  return index.replays;
}

export async function loadReplay(id: string): Promise<Replay> {
  const replay = await getJson<Replay>(`${BASE}/${encodeURIComponent(id)}.json`);
  if (replay.schema_version !== SUPPORTED_SCHEMA) {
    throw new Error(`Unsupported replay schema version ${replay.schema_version}`);
  }
  return replay;
}
