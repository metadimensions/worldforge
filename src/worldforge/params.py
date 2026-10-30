from __future__ import annotations

import math
from typing import Any

import numpy as np

from .models import MovingObstacle, Obstacle, Scenario, SimulationResult

FAMILY = "forklift_crossing"
WORLD_W, WORLD_H = 800.0, 600.0
AISLE_CENTER_Y = 300.0
ROBOT_Y = 305.0
RACK_X_MIN, RACK_X_MAX = 60.0, 740.0
RACK_Y_MIN, RACK_Y_MAX = 40.0, 560.0
SEED_MAX = 2**31 - 1

PARAMETERS: dict[str, dict[str, Any]] = {
    "forklift_speed": {"type": "number", "min": 40.0, "max": 200.0, "default": 120.0, "unit": "units/s",
                       "description": "Forklift travel speed."},
    "forklift_start_time": {"type": "number", "min": 0.0, "max": 8.0, "default": 2.3, "unit": "s",
                            "description": "When the forklift starts moving from the end of the cross aisle."},
    "forklift_direction": {"type": "enum", "values": ["southbound", "northbound"], "default": "southbound",
                           "description": "southbound drives from y=30 to y=570 (top to bottom of the map); northbound the reverse."},
    "forklift_width": {"type": "number", "min": 30.0, "max": 70.0, "default": 60.0, "unit": "units",
                       "description": "Forklift size along x (across the cross aisle). Must be < cross_aisle_width."},
    "forklift_length": {"type": "number", "min": 20.0, "max": 80.0, "default": 40.0, "unit": "units",
                        "description": "Forklift size along y (its direction of travel)."},
    "aisle_width": {"type": "number", "min": 50.0, "max": 240.0, "default": 160.0, "unit": "units",
                    "description": "Width of the main east-west aisle the robot drives along (centred on y=300)."},
    "cross_aisle_width": {"type": "number", "min": 50.0, "max": 200.0, "default": 80.0, "unit": "units",
                          "description": "Width of the north-south cross aisle the forklift uses."},
    "cross_aisle_x": {"type": "number", "min": 250.0, "max": 550.0, "default": 400.0, "unit": "units",
                      "description": "x position of the cross aisle centre (the intersection)."},
    "robot_speed": {"type": "number", "min": 40.0, "max": 120.0, "default": 80.0, "unit": "units/s",
                    "description": "Robot maximum speed."},
    "robot_start_x": {"type": "number", "min": 30.0, "max": 200.0, "default": 55.0, "unit": "units",
                      "description": "Robot start x (y is fixed at 305, in the main aisle)."},
    "goal_x": {"type": "number", "min": 600.0, "max": 770.0, "default": 745.0, "unit": "units",
               "description": "Goal x (y is fixed at 305, in the main aisle)."},
}

DEFAULTS: dict[str, Any] = {k: v["default"] for k, v in PARAMETERS.items()}


def parameter_space() -> dict[str, Any]:
    return {
        "family": FAMILY,
        "units": "1 simulation unit = 1 cm; times in seconds",
        "world": {"width": WORLD_W, "height": WORLD_H, "coordinates": "origin top-left, +x east, +y south"},
        "fixed": {"robot_radius": 15.0, "robot_y": ROBOT_Y, "dt": 0.05, "max_steps": 1200,
                  "layout": "four shelving racks forming a main east-west aisle and a north-south cross aisle"},
        "parameters": PARAMETERS,
        "seed": {"type": "integer", "min": 0, "max": SEED_MAX},
    }


class ParamError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def validate_params(overrides: Any) -> dict[str, Any]:
    if overrides is None:
        overrides = {}
    if not isinstance(overrides, dict):
        raise ParamError(["parameters must be a JSON object"])
    errors: list[str] = []
    params = dict(DEFAULTS)
    for name, value in overrides.items():
        spec = PARAMETERS.get(name)
        if spec is None:
            errors.append(f"unsupported parameter: {name!r}")
            continue
        if value is None:
            continue
        if spec["type"] == "enum":
            if value not in spec["values"]:
                errors.append(f"{name} must be one of {spec['values']}, got {value!r}")
                continue
            params[name] = value
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append(f"{name} must be a number, got {type(value).__name__}")
                continue
            if not math.isfinite(value):
                errors.append(f"{name} must be finite")
                continue
            if not spec["min"] <= value <= spec["max"]:
                errors.append(f"{name}={value} is out of range [{spec['min']}, {spec['max']}]")
                continue
            params[name] = float(value)

    if not errors:
        if params["forklift_width"] >= params["cross_aisle_width"] - 2:
            errors.append(f"invalid obstacle placement: forklift_width ({params['forklift_width']}) must be at "
                          f"least 2 units narrower than cross_aisle_width ({params['cross_aisle_width']})")
    if errors:
        raise ParamError(errors)
    return params


def validate_seed(seed: Any) -> int:
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= SEED_MAX:
        raise ParamError([f"seed must be an integer in [0, {SEED_MAX}]"])
    return seed


def build_scenario(params: dict[str, Any], scenario_id: str = "forklift_crossing") -> Scenario:
    p = params
    half_aisle = p["aisle_width"] / 2
    top_y1 = AISLE_CENTER_Y - half_aisle
    bot_y0 = AISLE_CENTER_Y + half_aisle
    cx, half_cross = p["cross_aisle_x"], p["cross_aisle_width"] / 2
    west_x = (RACK_X_MIN, cx - half_cross)
    east_x = (cx + half_cross, RACK_X_MAX)

    def rack(rid, xs, ys):
        return Obstacle(rid, "rect", x=(xs[0] + xs[1]) / 2, y=(ys[0] + ys[1]) / 2,
                        width=xs[1] - xs[0], height=ys[1] - ys[0])

    racks = [
        rack("rack_nw", west_x, (RACK_Y_MIN, top_y1)),
        rack("rack_ne", east_x, (RACK_Y_MIN, top_y1)),
        rack("rack_sw", west_x, (bot_y0, RACK_Y_MAX)),
        rack("rack_se", east_x, (bot_y0, RACK_Y_MAX)),
    ]
    path = [(cx, 30.0), (cx, 570.0)]
    if p["forklift_direction"] == "northbound":
        path.reverse()
    forklift = MovingObstacle("forklift", "rect", path=path, speed=p["forklift_speed"],
                              width=p["forklift_width"], height=p["forklift_length"],
                              start_time=p["forklift_start_time"], mode="once")
    return Scenario(
        id=scenario_id,
        description="Forklift-crossing family: robot drives the main aisle while a forklift crosses it.",
        start=(p["robot_start_x"], ROBOT_Y),
        goal=(p["goal_x"], ROBOT_Y),
        max_speed=p["robot_speed"],
        static_obstacles=racks,
        moving_obstacles=[forklift],
    )


def sample_random(rng: np.random.Generator) -> dict[str, Any]:
    for _ in range(1000):
        cand: dict[str, Any] = {}
        for name, spec in PARAMETERS.items():
            if spec["type"] == "enum":
                cand[name] = spec["values"][int(rng.integers(len(spec["values"])))]
            else:
                cand[name] = round(float(rng.uniform(spec["min"], spec["max"])), 2)
        try:
            return validate_params(cand)
        except ParamError:
            continue
    raise RuntimeError("could not sample a valid parameter set")


def random_batch(count: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(count):
        params = sample_random(rng)
        out.append({"params": params, "seed": int(rng.integers(0, SEED_MAX))})
    return out


def classify_failure(scenario: Scenario, result: SimulationResult) -> str | None:
    if result.outcome == "success":
        return None
    if result.outcome == "collision":
        c = result.collision
        if c is None or c.obstacle_id == "wall":
            return "collision:wall"
        mover = next((m for m in scenario.moving_obstacles if m.id == c.obstacle_id), None)
        if mover is None:
            return "collision:static"
        ox, oy = mover.position_at(c.t)
        heading = result.trajectory[-1].heading
        rel = math.atan2(oy - c.y, ox - c.x) - heading
        rel = abs((rel + math.pi) % (2 * math.pi) - math.pi)
        side = "front" if rel < math.pi / 4 else "rear" if rel > 3 * math.pi / 4 else "side"
        return f"collision:moving:{side}"
    if result.outcome == "no_path":
        return f"no_path:{result.diagnostics.get('blocked', 'unknown')}"
    return result.outcome
