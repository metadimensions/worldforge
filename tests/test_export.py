import json

from worldforge.export import build_replay, main
from worldforge.models import Scenario
from worldforge.scenarios import get_scenario
from worldforge.simulator import run_simulation


def test_replay_embeds_unmodified_result_and_scenario():
    sc = get_scenario("failure")
    r = run_simulation(sc, seed=42)
    doc = json.loads(json.dumps(build_replay(sc, r)))
    assert doc["result"] == json.loads(r.to_json())
    assert Scenario.from_dict(doc["scenario"]) == sc


def test_moving_tracks_match_engine_at_every_timestamp():
    sc = get_scenario("failure")
    r = run_simulation(sc, seed=42)
    track = build_replay(sc, r)["moving_obstacle_tracks"][0]
    assert track["id"] == "forklift"
    assert [s["t"] for s in track["samples"]] == [p.t for p in r.trajectory]
    for s in track["samples"]:
        assert (s["x"], s["y"]) == sc.moving_obstacles[0].position_at(s["t"])


def test_cli_exports_all_scenarios(tmp_path):
    assert main(["--out-dir", str(tmp_path)]) == 0
    index = json.loads((tmp_path / "index.json").read_text())
    outcomes = {e["id"]: e["outcome"] for e in index["replays"]}
    assert outcomes == {"success": "success", "failure": "collision", "no_path": "no_path"}
    for e in index["replays"]:
        assert json.loads((tmp_path / e["file"]).read_text())["result"]["scenario_id"] == e["id"]


def test_web_fixtures_match_current_simulator():
    from pathlib import Path

    import pytest

    fixtures = Path(__file__).resolve().parents[1] / "web" / "public" / "replays"
    if not fixtures.exists():
        pytest.skip("no web fixtures")
    index = json.loads((fixtures / "index.json").read_text())
    for e in index["replays"]:
        sc = get_scenario(e["id"])
        expected = json.loads(json.dumps(build_replay(sc, run_simulation(sc, seed=e["seed"]))))
        assert json.loads((fixtures / e["file"]).read_text()) == expected, e["id"]
