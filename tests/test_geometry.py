import math

import pytest

from worldforge.geometry import (circle_hits_obstacle, distance_to_walls, path_length,
                                 point_to_circle_distance, point_to_rect_distance, segment_samples)
from worldforge.models import MovingObstacle, Obstacle


def test_rect_distance_outside_edge_and_corner():
    assert point_to_rect_distance(20, 0, 0, 0, 20, 10) == pytest.approx(10)
    assert point_to_rect_distance(13, 8, 0, 0, 20, 10) == pytest.approx(math.hypot(3, 3))


def test_rect_distance_inside_is_negative():
    assert point_to_rect_distance(0, 0, 0, 0, 20, 10) == pytest.approx(-5)


def test_circle_distance():
    assert point_to_circle_distance(10, 0, 0, 0, 4) == pytest.approx(6)
    assert point_to_circle_distance(1, 0, 0, 0, 4) == pytest.approx(-3)


def test_circle_overlap_accounts_for_radius():
    wall = Obstacle("w", "rect", x=100, y=100, width=20, height=20)
    assert not circle_hits_obstacle((130, 100), 15, wall)
    assert circle_hits_obstacle((120, 100), 15, wall)


def test_wall_distance():
    assert distance_to_walls((10, 50), 800, 600) == 10
    assert distance_to_walls((-1, 50), 800, 600) == -1


def test_segment_samples_spacing():
    pts = segment_samples((0, 0), (10, 0), 3)
    assert pts[-1] == (10, 0)
    assert all(math.dist(a, b) <= 3 for a, b in zip([(0, 0)] + pts, pts))
    assert path_length([(0, 0), (3, 4), (3, 10)]) == pytest.approx(11)


def test_moving_obstacle_modes_are_deterministic():
    m = MovingObstacle("m", "circle", path=[(0, 0), (10, 0)], speed=5, radius=1, start_time=1)
    assert m.position_at(0.5) == (0, 0)
    assert m.position_at(2) == pytest.approx((5, 0))
    assert m.position_at(100) == pytest.approx((10, 0))
    m.mode = "pingpong"
    assert m.position_at(4) == pytest.approx((5, 0))
