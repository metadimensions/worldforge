import json
import math
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from worldforge.params import (DEFAULTS, ParamError, build_scenario, classify_failure, random_batch,
                               validate_params)
from worldforge.scenarios import get_scenario
from worldforge.simulator import run_simulation
from worldforge.worker import Handler, handle


def test_defaults_rebuild_the_failure_scenario_exactly():
    built = build_scenario(validate_params({}), "failure")
    ref = get_scenario("failure")
    assert built.static_obstacles == ref.static_obstacles
    assert built.moving_obstacles == ref.moving_obstacles
    assert (built.start, built.goal, built.max_speed) == (ref.start, ref.goal, ref.max_speed)
    assert run_simulation(built, 42).trajectory == run_simulation(ref, 42).trajectory


@pytest.mark.parametrize("bad, fragment", [
    ({"teleport": True}, "unsupported parameter"),
    ({"forklift_speed": 999}, "out of range"),
    ({"forklift_speed": "fast"}, "must be a number"),
    ({"forklift_speed": True}, "must be a number"),
    ({"forklift_speed": math.nan}, "must be finite"),
    ({"forklift_direction": "sideways"}, "must be one of"),
    ({"forklift_width": 70, "cross_aisle_width": 60}, "invalid obstacle placement"),
])
def test_invalid_parameters_are_rejected(bad, fragment):
    with pytest.raises(ParamError) as e:
        validate_params(bad)
    assert any(fragment in msg for msg in e.value.errors)


def test_null_means_baseline_value():
    assert validate_params({"forklift_speed": None}) == DEFAULTS


def test_random_batch_is_deterministic_and_valid():
    a, b = random_batch(5, 123), random_batch(5, 123)
    assert a == b and a != random_batch(5, 124)
    for item in a:
        assert validate_params(item["params"]) == item["params"]


def test_failure_classification_uses_actual_output():
    sc = get_scenario("failure")
    assert classify_failure(sc, run_simulation(sc, 42)) == "collision:moving:side"
    sc = get_scenario("success")
    assert classify_failure(sc, run_simulation(sc, 42)) is None
    sc = get_scenario("no_path")
    assert classify_failure(sc, run_simulation(sc, 42)) == "no_path:goal_enclosed"


def test_handle_simulate_returns_actual_result_and_replay():
    status, body = handle("POST", "/simulate", {"params": {}, "seed": 42})
    assert status == 200
    assert body["outcome"] == "collision" and body["failure_mode"] == "collision:moving:side"
    assert body["replay"]["result"]["collision"]["obstacle_id"] == "forklift"
    assert body["metrics"] == body["replay"]["result"]["metrics"]


def test_handle_rejects_bad_requests():
    assert handle("POST", "/simulate", {"params": {"forklift_speed": -5}})[0] == 400
    assert handle("POST", "/simulate", {"params": {}, "code": "import os"})[0] == 400
    assert handle("POST", "/simulate", {"params": {}, "seed": -1})[0] == 400
    assert handle("POST", "/simulate-batch", {"items": [{}] * 21})[0] == 400
    assert handle("POST", "/random-params", {"count": 0, "seed": 1})[0] == 400
    assert handle("POST", "/simulate", "not an object")[0] == 400
    status, body = handle("POST", "/validate", {"items": [{"params": {"x": 1}}, {"params": {}}]})
    assert status == 200 and [r["valid"] for r in body["results"]] == [False, True]


def test_http_server_auth_and_json():
    Handler.token = "secret"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        def post(path, payload, token="secret"):
            req = urllib.request.Request(url + path, data=json.dumps(payload).encode(), method="POST",
                                         headers={"Authorization": f"Bearer {token}"} if token else {})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.load(r)
            except urllib.error.HTTPError as e:
                return e.code, json.load(e)

        assert post("/simulate", {"params": {}}, token=None)[0] == 401
        assert post("/simulate", {"params": {}}, token="wrong")[0] == 401
        status, body = post("/simulate", {"params": {"forklift_start_time": 6.5}, "seed": 1})
        assert status == 200 and body["outcome"] == "success"
        with urllib.request.urlopen(url + "/health") as r:
            assert json.load(r) == {"ok": True}
    finally:
        server.shutdown()
        Handler.token = None
