export type Point = [number, number];

export type Outcome = "success" | "collision" | "timeout" | "no_path" | "stuck";

export interface Obstacle {
  id: string;
  kind: "rect" | "circle";
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface MovingObstacleDef {
  id: string;
  kind: "rect" | "circle";
  path: Point[];
  speed: number;
  width: number;
  height: number;
  radius: number;
  start_time: number;
  mode: string;
}

export interface Scenario {
  id: string;
  description: string;
  width: number;
  height: number;
  start: Point;
  goal: Point;
  robot_radius: number;
  max_speed: number;
  dt: number;
  max_steps: number;
  goal_tolerance: number;
  static_obstacles: Obstacle[];
  moving_obstacles: MovingObstacleDef[];
  expected_outcome: string | null;
  failure_explanation: string;
}

export interface TrajectoryPoint {
  t: number;
  x: number;
  y: number;
  heading: number;
  status: string;
}

export interface CollisionInfo {
  t: number;
  step: number;
  x: number;
  y: number;
  obstacle_id: string;
}

export interface SimulationResult {
  scenario_id: string;
  seed: number;
  outcome: Outcome;
  reason: string;
  steps: number;
  duration: number;
  goal: Point;
  start: Point;
  planned_path: Point[];
  trajectory: TrajectoryPoint[];
  metrics: Record<string, number | null>;
  collision: CollisionInfo | null;
  replans: { t: number; found: boolean; path: Point[] }[];
  diagnostics?: Diagnostics;
}

export interface Diagnostics {
  blocked?: "goal_in_obstacle" | "start_in_obstacle" | "goal_enclosed" | "start_enclosed";
  blocking_obstacle_ids?: string[];
  message?: string;
}

export interface TrackSample {
  t: number;
  x: number;
  y: number;
}

export interface MovingObstacleTrack {
  id: string;
  kind: "rect" | "circle";
  width: number;
  height: number;
  radius: number;
  samples: TrackSample[];
}

export interface Replay {
  schema_version: number;
  scenario: Scenario;
  result: SimulationResult;
  moving_obstacle_tracks: MovingObstacleTrack[];
}

export interface ReplayIndexEntry {
  id: string;
  file: string;
  seed: number;
  outcome: Outcome;
  description: string;
}
