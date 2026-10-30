from __future__ import annotations

from typing import Callable

from .models import MovingObstacle, Obstacle, Scenario


def success_scenario() -> Scenario:
    return Scenario(
        id="success",
        description="Open warehouse with two obstacles away from the direct route.",
        start=(55.0, 305.0),
        goal=(745.0, 305.0),
        static_obstacles=[
            Obstacle("rack_north", "rect", x=400, y=120, width=220, height=100),
            Obstacle("pillar_south", "circle", x=250, y=470, radius=40),
        ],
        expected_outcome="success",
    )


def forklift_crossing_scenario() -> Scenario:
    return Scenario(
        id="failure",
        description="Forklift crosses the main aisle as the robot passes the intersection.",
        start=(55.0, 305.0),
        goal=(745.0, 305.0),
        static_obstacles=[
            Obstacle("rack_nw", "rect", x=210, y=130, width=300, height=180),
            Obstacle("rack_ne", "rect", x=590, y=130, width=300, height=180),
            Obstacle("rack_sw", "rect", x=210, y=470, width=300, height=180),
            Obstacle("rack_se", "rect", x=590, y=470, width=300, height=180),
        ],
        moving_obstacles=[
            MovingObstacle("forklift", "rect", path=[(400.0, 30.0), (400.0, 570.0)],
                           speed=120.0, width=60, height=40, start_time=2.3, mode="once"),
        ],
        expected_outcome="collision",
        failure_explanation=(
            "The reactive controller checks each next movement step against the current "
            "obstacle positions, but does not predict the forklift's future trajectory. "
            "The forklift is beside the robot rather than in front of it, so every step "
            "looks clear and the robot continues east as the forklift crosses the aisle."
        ),
    )


def no_path_scenario() -> Scenario:
    return Scenario(
        id="no_path",
        description="Goal enclosed by racks; no route exists.",
        start=(55.0, 305.0),
        goal=(650.0, 300.0),
        static_obstacles=[
            Obstacle("wall_w", "rect", x=560, y=300, width=20, height=220),
            Obstacle("wall_e", "rect", x=740, y=300, width=20, height=220),
            Obstacle("wall_n", "rect", x=650, y=200, width=200, height=20),
            Obstacle("wall_s", "rect", x=650, y=400, width=200, height=20),
        ],
        expected_outcome="no_path",
    )


SCENARIOS: dict[str, Callable[[], Scenario]] = {
    "success": success_scenario,
    "failure": forklift_crossing_scenario,
    "no_path": no_path_scenario,
}


def get_scenario(name: str) -> Scenario:
    try:
        return SCENARIOS[name]()
    except KeyError:
        raise KeyError(f"unknown scenario {name!r}; choose from {sorted(SCENARIOS)}") from None


def list_scenarios() -> list[str]:
    return list(SCENARIOS)
