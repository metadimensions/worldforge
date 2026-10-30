import math

from worldforge.controller import WaypointController
from worldforge.environment import Environment
from worldforge.models import MovingObstacle, Obstacle, Scenario
from worldforge.simulator import run_simulation


def _drive(sc, path, steps=400):
    env = Environment(sc)
    ctl = WaypointController(sc, env, path)
    pos, heading = path[0], 0.0
    positions = [pos]
    for k in range(steps):
        cmd = ctl.step(pos, heading, k * sc.dt, env.obstacles_at(k * sc.dt))
        assert math.dist(pos, cmd.position) <= sc.max_speed * sc.dt + 1e-9
        pos, heading = cmd.position, cmd.heading
        positions.append(pos)
    return env, positions


def test_robot_cannot_drive_through_static_wall():
    wall = Obstacle("wall", "rect", x=400, y=300, width=10, height=600)
    sc = Scenario(id="wall", static_obstacles=[wall], replan_after_blocked_steps=10_000)
    env, positions = _drive(sc, [(100.0, 300.0), (700.0, 300.0)])
    for p in positions:
        assert env.collision(p, sc.robot_radius, env.static_obstacles) is None
        assert p[0] < 400
    assert positions[-1][0] > 360


def test_robot_cannot_leave_warehouse_boundary():
    sc = Scenario(id="edge")
    env, positions = _drive(sc, [(100.0, 300.0), (-200.0, 300.0)])
    for p in positions:
        assert p[0] >= sc.robot_radius


def test_thin_obstacle_is_not_tunnelled_through():
    wall = Obstacle("thin", "rect", x=300, y=300, width=2, height=600)
    sc = Scenario(id="thin", max_speed=1000, static_obstacles=[wall], replan_after_blocked_steps=10_000)
    env, positions = _drive(sc, [(100.0, 300.0), (700.0, 300.0)], steps=50)
    assert all(p[0] < 300 for p in positions)


def test_stuck_when_aisle_is_permanently_blocked():
    sc = Scenario(
        id="blocked", width=800, height=100, start=(55, 50), goal=(745, 50),
        moving_obstacles=[MovingObstacle("jack", "rect", path=[(400, 50)], speed=0, width=40, height=100)],
    )
    r = run_simulation(sc, seed=1)
    assert r.outcome == "stuck"
    assert r.collision is None
    assert r.metrics["replan_count"] >= 1 and not any(rp["found"] for rp in r.replans)


def test_timeout_respects_step_limit():
    sc = Scenario(id="short", max_steps=20)
    r = run_simulation(sc, seed=0)
    assert r.outcome == "timeout" and r.steps == 20 and len(r.trajectory) == 21


def test_start_inside_obstacle_is_collision():
    sc = Scenario(id="bad", static_obstacles=[Obstacle("box", "circle", 60, 300, radius=30)])
    r = run_simulation(sc)
    assert r.outcome == "collision" and r.collision.obstacle_id == "box" and r.steps == 0
