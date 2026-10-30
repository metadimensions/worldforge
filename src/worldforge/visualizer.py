from __future__ import annotations

import math

import pygame

from .models import Scenario, SimulationResult
from .scenarios import get_scenario
from .simulator import run_simulation

PANEL_W = 300
MARGIN = 20

BG = (236, 233, 226)
FLOOR = (250, 249, 245)
GRID = (232, 229, 222)
WALL = (60, 60, 66)
RACK = (88, 99, 116)
MOVER = (230, 126, 34)
START = (46, 160, 90)
GOAL = (200, 50, 60)
PLAN = (70, 120, 220)
REPLAN = (150, 90, 200)
TRAIL = (20, 170, 190)
ROBOT = (30, 40, 60)
TEXT = (30, 30, 36)
MUTED = (110, 110, 120)
OUTCOME_COLOURS = {"success": START, "collision": GOAL, "timeout": MOVER,
                   "stuck": MOVER, "no_path": REPLAN}

KEY_SCENARIOS = {pygame.K_1: "success", pygame.K_2: "failure", pygame.K_3: "no_path"}


class Replay:

    def __init__(self, scenario: Scenario, result: SimulationResult):
        self.scenario = scenario
        self.result = result
        self.frame = 0
        self.font = pygame.font.SysFont("menlo,consolas,monospace", 14)
        self.big = pygame.font.SysFont("helvetica,arial,sans", 22, bold=True)

    @property
    def last_frame(self) -> int:
        return len(self.result.trajectory) - 1

    @property
    def finished(self) -> bool:
        return self.frame >= self.last_frame

    def size(self) -> tuple[int, int]:
        return int(self.scenario.width) + 2 * MARGIN + PANEL_W, int(self.scenario.height) + 2 * MARGIN

    @staticmethod
    def _w(p) -> tuple[int, int]:
        return int(round(p[0])) + MARGIN, int(round(p[1])) + MARGIN

    def _draw_obstacle(self, surf, obs, colour):
        if obs.kind == "rect":
            r = pygame.Rect(0, 0, obs.width, obs.height)
            r.center = self._w((obs.x, obs.y))
            pygame.draw.rect(surf, colour, r, border_radius=3)
        else:
            pygame.draw.circle(surf, colour, self._w((obs.x, obs.y)), int(obs.radius))

    def _dashed(self, surf, colour, pts, dash=8):
        for a, b in zip(pts, pts[1:]):
            length = math.dist(a, b)
            n = max(1, int(length // dash))
            for i in range(0, n, 2):
                p0 = (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
                p1 = (a[0] + (b[0] - a[0]) * min(i + 1, n) / n, a[1] + (b[1] - a[1]) * min(i + 1, n) / n)
                pygame.draw.line(surf, colour, self._w(p0), self._w(p1), 2)

    def draw(self, surf: pygame.Surface) -> None:
        sc, res = self.scenario, self.result
        frame = min(self.frame, self.last_frame)
        tp = res.trajectory[frame]
        surf.fill(BG)

        floor = pygame.Rect(MARGIN, MARGIN, sc.width, sc.height)
        pygame.draw.rect(surf, FLOOR, floor)
        step = int(sc.grid_resolution * 5)
        for x in range(0, int(sc.width) + 1, step):
            pygame.draw.line(surf, GRID, self._w((x, 0)), self._w((x, sc.height)))
        for y in range(0, int(sc.height) + 1, step):
            pygame.draw.line(surf, GRID, self._w((0, y)), self._w((sc.width, y)))
        pygame.draw.rect(surf, WALL, floor, 3)

        for obs in sc.static_obstacles:
            self._draw_obstacle(surf, obs, RACK)
        for mo in sc.moving_obstacles:
            pygame.draw.lines(surf, (240, 200, 160), False, [self._w(p) for p in mo.path], 1)
            self._draw_obstacle(surf, mo.at(tp.t), MOVER)

        if len(res.planned_path) >= 2:
            self._dashed(surf, PLAN, res.planned_path)
        for rp in res.replans:
            if rp["found"] and rp["t"] <= tp.t and len(rp["path"]) >= 2:
                self._dashed(surf, REPLAN, rp["path"])

        pygame.draw.circle(surf, START, self._w(res.start), 6)
        pygame.draw.circle(surf, GOAL, self._w(res.goal), max(3, int(sc.goal_tolerance)), 2)
        pygame.draw.circle(surf, GOAL, self._w(res.goal), 3)

        trail = [self._w((p.x, p.y)) for p in res.trajectory[: frame + 1]]
        if len(trail) >= 2:
            pygame.draw.lines(surf, TRAIL, False, trail, 2)

        c = self._w((tp.x, tp.y))
        pygame.draw.circle(surf, ROBOT, c, int(sc.robot_radius))
        pygame.draw.circle(surf, (255, 255, 255), c, int(sc.robot_radius), 2)
        hx = tp.x + math.cos(tp.heading) * sc.robot_radius
        hy = tp.y + math.sin(tp.heading) * sc.robot_radius
        pygame.draw.line(surf, (255, 220, 80), c, self._w((hx, hy)), 3)

        if self.finished and res.collision:
            cx, cy = self._w((res.collision.x, res.collision.y))
            for d in (-1, 1):
                pygame.draw.line(surf, GOAL, (cx - 12, cy - 12 * d), (cx + 12, cy + 12 * d), 4)

        self._draw_panel(surf, tp, frame)

    def _draw_panel(self, surf, tp, frame):
        sc, res = self.scenario, self.result
        x0 = int(sc.width) + 2 * MARGIN
        pygame.draw.rect(surf, (255, 255, 255), (x0, 0, PANEL_W, surf.get_height()))
        y = MARGIN

        def line(text, colour=TEXT, font=None, gap=4):
            nonlocal y
            img = (font or self.font).render(text, True, colour)
            surf.blit(img, (x0 + 14, y))
            y += img.get_height() + gap

        line("WorldForge", font=self.big, gap=2)
        line(f"scenario: {sc.id}   seed: {res.seed}", MUTED, gap=12)
        line(f"t = {tp.t:6.2f} s   step {frame}/{self.last_frame}")
        line(f"status: {tp.status}", gap=12)
        if self.finished:
            line(res.outcome.upper(), OUTCOME_COLOURS.get(res.outcome, TEXT), self.big)
            for chunk in _wrap(res.reason, 34):
                line(chunk, MUTED)
            y += 8
            for k, v in res.metrics.items():
                if isinstance(v, float):
                    v = f"{v:.2f}"
                line(f"{k[:22]:<22} {v}")
            if res.collision:
                line(f"{'collision_with':<22} {res.collision.obstacle_id}")
        else:
            line("running...", MUTED)

        y = surf.get_height() - 120
        for text in ("Space pause/resume   R restart", "1 success  2 failure  3 no_path",
                     "+/- playback speed    Esc quit"):
            line(text, MUTED)


def _wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return lines + [cur] if cur else lines


def load(name: str, seed: int) -> Replay:
    scenario = get_scenario(name)
    return Replay(scenario, run_simulation(scenario, seed=seed))


def run_viewer(scenario_name: str = "success", seed: int = 42, max_frames: int | None = None) -> None:
    pygame.init()
    pygame.display.set_caption("WorldForge")
    replay = load(scenario_name, seed)
    screen = pygame.display.set_mode(replay.size())
    clock = pygame.time.Clock()
    paused, speed, acc, drawn = False, 1.0, 0.0, 0
    try:
        while True:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_ESCAPE:
                        return
                    if event.key == pygame.K_SPACE:
                        paused = not paused
                    elif event.key == pygame.K_r:
                        replay.frame, acc, paused = 0, 0.0, False
                    elif event.key in KEY_SCENARIOS:
                        replay = load(KEY_SCENARIOS[event.key], seed)
                        screen = pygame.display.set_mode(replay.size())
                        acc, paused = 0.0, False
                    elif event.key in (pygame.K_PLUS, pygame.K_EQUALS, pygame.K_KP_PLUS):
                        speed = min(speed * 2, 16.0)
                    elif event.key in (pygame.K_MINUS, pygame.K_KP_MINUS):
                        speed = max(speed / 2, 0.125)

            dt_real = clock.tick(60) / 1000.0
            if not paused and not replay.finished:
                acc += dt_real * speed
                advance = int(acc / replay.scenario.dt)
                if advance:
                    acc -= advance * replay.scenario.dt
                    replay.frame = min(replay.frame + advance, replay.last_frame)

            replay.draw(screen)
            if paused:
                img = replay.big.render("PAUSED", True, GOAL)
                screen.blit(img, (MARGIN + 10, MARGIN + 10))
            pygame.display.flip()
            drawn += 1
            if max_frames is not None and drawn >= max_frames:
                return
    finally:
        pygame.quit()
