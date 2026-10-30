from worldforge.scenarios import get_scenario
from worldforge.simulator import run_simulation


def test_failure_scenario_is_a_forklift_collision():
    sc = get_scenario("failure")
    r = run_simulation(sc, seed=42)
    assert r.outcome == sc.expected_outcome == "collision", r.reason
    assert r.collision.obstacle_id == "forklift"
    assert r.trajectory[-1].status == "moving"
    assert r.metrics["wait_steps"] == 0


def test_failure_is_reproducible_across_runs():
    results = [run_simulation(get_scenario("failure"), seed=42).to_dict() for _ in range(5)]
    assert all(r == results[0] for r in results[1:])
    assert results[0]["outcome"] == "collision"


def test_failure_is_caused_by_the_forklift_not_the_layout():
    sc = get_scenario("failure")
    sc.moving_obstacles = []
    assert run_simulation(sc, seed=42).outcome == "success"


def test_failure_depends_on_forklift_timing():
    sc = get_scenario("failure")
    sc.moving_obstacles[0].start_time += 4.0
    assert run_simulation(sc, seed=42).outcome == "success"
