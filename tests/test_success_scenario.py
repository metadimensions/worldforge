import json
import math

from worldforge.models import Scenario
from worldforge.scenarios import get_scenario, list_scenarios
from worldforge.simulator import run_simulation

REQUIRED_METRICS = {"distance_travelled", "straight_line_distance", "path_efficiency",
                    "min_clearance", "final_distance_to_goal", "planned_path_length",
                    "replan_count", "wait_steps", "goal_progress"}


def test_success_scenario_reaches_goal_without_collision():
    sc = get_scenario("success")
    r = run_simulation(sc, seed=42)
    assert r.outcome == "success", r.reason
    assert r.collision is None
    assert math.dist((r.trajectory[-1].x, r.trajectory[-1].y), sc.goal) <= sc.goal_tolerance
    assert r.metrics["min_clearance"] > 0
    assert 0 < r.metrics["path_efficiency"] <= 1


def test_result_is_json_serialisable_with_required_fields():
    r = run_simulation(get_scenario("success"), seed=42)
    d = json.loads(r.to_json())
    assert d["scenario_id"] == "success" and d["seed"] == 42 and d["outcome"] == "success"
    assert REQUIRED_METRICS <= set(d["metrics"])
    assert d["planned_path"] and d["goal"] == [745.0, 305.0]
    assert len(d["trajectory"]) == d["steps"] + 1
    assert set(d["trajectory"][0]) >= {"t", "x", "y", "heading"}
    assert d["duration"] == round(d["steps"] * 0.05, 6)


def test_scenario_json_round_trip_gives_identical_result():
    for name in list_scenarios():
        sc = get_scenario(name)
        sc2 = Scenario.from_json(sc.to_json())
        assert sc2 == sc
        assert run_simulation(sc2, seed=7).to_dict() == run_simulation(sc, seed=7).to_dict()


def test_every_simulation_terminates_within_step_limit():
    for name in list_scenarios():
        sc = get_scenario(name)
        r = run_simulation(sc, seed=3)
        assert r.outcome in {"success", "collision", "timeout", "no_path", "stuck"}
        assert 0 <= r.steps <= sc.max_steps
        assert len(r.trajectory) == r.steps + 1


def test_no_path_scenario():
    r = run_simulation(get_scenario("no_path"))
    assert r.outcome == "no_path" and r.planned_path == [] and r.steps == 0
    assert sorted(r.diagnostics["blocking_obstacle_ids"]) == ["wall_e", "wall_n", "wall_s", "wall_w"]
    assert r.reason == r.diagnostics["message"]


def test_seed_controls_start_jitter():
    sc = get_scenario("success")
    sc.start_jitter = 5.0
    a, b, c = (run_simulation(sc, seed=s) for s in (1, 1, 2))
    assert a.start == b.start != c.start
    assert a.outcome == "success"
