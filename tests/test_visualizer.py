import os

import pytest

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
pygame = pytest.importorskip("pygame")

from worldforge.scenarios import get_scenario  # noqa: E402
from worldforge.simulator import run_simulation  # noqa: E402


@pytest.mark.parametrize("name", ["success", "failure", "no_path"])
def test_replay_draws_every_frame_of_recorded_result(name):
    from worldforge.visualizer import Replay
    pygame.init()
    try:
        sc = get_scenario(name)
        result = run_simulation(sc, seed=42)
        replay = Replay(sc, result)
        surf = pygame.Surface(replay.size())
        for f in range(0, replay.last_frame + 1, 10):
            replay.frame = f
            replay.draw(surf)
        replay.frame = replay.last_frame
        replay.draw(surf)
        assert replay.finished
    finally:
        pygame.quit()


def test_viewer_loop_runs_headless():
    from worldforge.visualizer import run_viewer
    run_viewer("failure", seed=42, max_frames=5)


def test_core_engine_does_not_import_pygame():
    import subprocess
    import sys
    code = ("import sys, worldforge; from worldforge import run_simulation, get_scenario; "
            "run_simulation(get_scenario('failure')); assert 'pygame' not in sys.modules")
    subprocess.run([sys.executable, "-c", code], check=True)
