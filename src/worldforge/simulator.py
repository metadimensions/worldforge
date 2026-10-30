from __future__ import annotations

import math
from collections import deque

import numpy as np

from .controller import WaypointController
from .environment import Environment
from .geometry import path_length
from .models import CollisionInfo, Point, Scenario, SimulationResult, TrajectoryPoint
from .planner import diagnose_no_path, plan_path


def run_simulation(scenario: Scenario, seed: int = 0) -> SimulationResult:
    sc = scenario
    rng = np.random.default_rng(seed)
    env = Environment(sc)

    start: Point = (float(sc.start[0]), float(sc.start[1]))
    if sc.start_jitter > 0:
        dx, dy = rng.uniform(-sc.start_jitter, sc.start_jitter, size=2)
        start = (start[0] + float(dx), start[1] + float(dy))
    goal: Point = (float(sc.goal[0]), float(sc.goal[1]))

    pos = start
    heading = math.atan2(goal[1] - start[1], goal[0] - start[0])
    trajectory = [TrajectoryPoint(0.0, pos[0], pos[1], heading, "start")]
    min_clearance = env.clearance(pos, sc.robot_radius, env.obstacles_at(0.0))
    distance = 0.0
    wait_steps = 0

    def finish(outcome, reason, steps, planned, collision=None, replans=None, diagnostics=None):
        straight = math.dist(start, goal)
        if outcome != "success":
            efficiency = None
        elif distance > 0:
            efficiency = round(min(1.0, straight / distance), 6)
        else:
            efficiency = 1.0
        metrics = {
            "distance_travelled": round(distance, 6),
            "straight_line_distance": round(straight, 6),
            "path_efficiency": efficiency,
            "min_clearance": None if math.isinf(min_clearance) else round(min_clearance, 6),
            "final_distance_to_goal": round(math.dist(pos, goal), 6),
            "goal_progress": round(1 - math.dist(pos, goal) / straight, 6) if straight > 0 else 1.0,
            "planned_path_length": round(path_length(planned), 6) if planned else None,
            "replan_count": len(replans or []),
            "wait_steps": wait_steps,
        }
        return SimulationResult(
            scenario_id=sc.id, seed=seed, outcome=outcome, reason=reason,
            steps=steps, duration=round(steps * sc.dt, 6), goal=goal, start=start,
            planned_path=planned or [], trajectory=trajectory, metrics=metrics,
            collision=collision, replans=replans or [], diagnostics=diagnostics or {},
        )

    hit = env.collision(pos, sc.robot_radius, env.obstacles_at(0.0))
    if hit is not None:
        return finish("collision", f"robot starts overlapping '{hit}'", 0, [],
                      CollisionInfo(0.0, 0, pos[0], pos[1], hit))

    planned = plan_path(start, goal, env.static_obstacles, sc.width, sc.height,
                        sc.grid_resolution, sc.robot_radius + sc.safety_margin)
    if planned is None:
        diag = diagnose_no_path(start, goal, env.static_obstacles, sc.width, sc.height,
                                sc.grid_resolution, sc.robot_radius + sc.safety_margin)
        return finish("no_path", diag["message"], 0, None, diagnostics=diag)

    controller = WaypointController(sc, env, planned)
    recent: deque[Point] = deque([pos], maxlen=sc.stuck_window + 1)

    for k in range(1, sc.max_steps + 1):
        t_prev, t = (k - 1) * sc.dt, k * sc.dt
        cmd = controller.step(pos, heading, t_prev, env.obstacles_at(t_prev))
        distance += math.dist(pos, cmd.position)
        pos, heading = cmd.position, cmd.heading
        if cmd.status != "moving":
            wait_steps += 1

        obstacles_now = env.obstacles_at(t)
        trajectory.append(TrajectoryPoint(round(t, 6), pos[0], pos[1], heading, cmd.status))
        min_clearance = min(min_clearance, env.clearance(pos, sc.robot_radius, obstacles_now))

        hit = env.collision(pos, sc.robot_radius, obstacles_now)
        if hit is not None:
            mover = any(m.id == hit for m in sc.moving_obstacles)
            reason = (f"moving obstacle '{hit}' hit the robot at t={t:.2f}s" if mover
                      else f"robot collided with '{hit}' at t={t:.2f}s")
            return finish("collision", reason, k, planned,
                          CollisionInfo(round(t, 6), k, pos[0], pos[1], hit), controller.replans)

        if math.dist(pos, goal) <= sc.goal_tolerance:
            return finish("success", f"reached goal at t={t:.2f}s", k, planned,
                          replans=controller.replans)

        recent.append(pos)
        if len(recent) == recent.maxlen and math.dist(recent[0], pos) < sc.stuck_min_progress:
            return finish("stuck", (f"moved < {sc.stuck_min_progress} units in the last "
                                    f"{sc.stuck_window} steps (t={t:.2f}s)"),
                          k, planned, replans=controller.replans)

    return finish("timeout", f"goal not reached within {sc.max_steps} steps", sc.max_steps,
                  planned, replans=controller.replans)

