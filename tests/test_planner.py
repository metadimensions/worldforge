import math

import numpy as np

from worldforge.geometry import distance_to_obstacle, segment_samples
from worldforge.models import Obstacle
from worldforge.planner import OccupancyGrid, astar, plan_path


def test_astar_open_warehouse_finds_straight_route():
    path = plan_path((55, 305), (745, 305), [], 800, 600, 10, 20)
    assert path is not None
    assert path[0] == (55, 305) and path[-1] == (745, 305)
    assert len(path) == 2


def test_astar_avoids_inflated_obstacles():
    rack = Obstacle("rack", "rect", x=400, y=300, width=60, height=300)
    radius, margin = 15, 5
    path = plan_path((100, 300), (700, 300), [rack], 800, 600, 10, radius + margin)
    assert path is not None
    for a, b in zip(path, path[1:]):
        for p in segment_samples(a, b, 1.0):
            assert distance_to_obstacle(p, rack) >= radius


def test_astar_no_diagonal_corner_cutting():
    grid = OccupancyGrid(50, 50, 10, [], 0)
    grid.occupied[:] = False
    grid.occupied[1, 2] = True
    grid.occupied[2, 1] = True
    cells = astar(grid, (1, 1), (2, 2))
    assert cells is not None
    for (c0, r0), (c1, r1) in zip(cells, cells[1:]):
        dc, dr = c1 - c0, r1 - r0
        if dc and dr:
            assert grid.is_free((c0 + dc, r0)) and grid.is_free((c0, r0 + dr))
    assert len(cells) > 2


def test_no_path_when_goal_enclosed():
    walls = [Obstacle("n", "rect", 400, 250, 200, 20), Obstacle("s", "rect", 400, 350, 200, 20),
             Obstacle("w", "rect", 300, 300, 20, 120), Obstacle("e", "rect", 500, 300, 20, 120)]
    assert plan_path((50, 50), (400, 300), walls, 800, 600, 10, 20) is None


def test_inflation_includes_boundary():
    grid = OccupancyGrid(100, 100, 10, [], 20)
    assert grid.occupied[0, 5] and grid.occupied[5, 0]
    assert not grid.occupied[5, 5]


def test_no_path_diagnosis_names_enclosing_obstacles():
    from worldforge.planner import diagnose_no_path
    walls = [Obstacle("n", "rect", 400, 250, 200, 20), Obstacle("s", "rect", 400, 350, 200, 20),
             Obstacle("w", "rect", 300, 300, 20, 120), Obstacle("e", "rect", 500, 300, 20, 120),
             Obstacle("far", "circle", 100, 500, radius=20)]
    d = diagnose_no_path((50, 50), (400, 300), walls, 800, 600, 10, 20)
    assert d["blocked"] == "goal_enclosed"
    assert sorted(d["blocking_obstacle_ids"]) == ["e", "n", "s", "w"]
    assert diagnose_no_path((400, 300), (50, 50), walls, 800, 600, 10, 20)["blocked"] == "start_enclosed"


def test_no_path_diagnosis_goal_inside_obstacle():
    from worldforge.planner import diagnose_no_path
    box = Obstacle("box", "rect", 400, 300, 100, 100)
    d = diagnose_no_path((50, 50), (400, 300), [box], 800, 600, 10, 20)
    assert d == {"blocked": "goal_in_obstacle", "blocking_obstacle_ids": ["box"],
                 "message": d["message"]}
