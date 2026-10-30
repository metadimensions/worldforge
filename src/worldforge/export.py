from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .models import Scenario, SimulationResult
from .scenarios import get_scenario, list_scenarios
from .simulator import run_simulation

SCHEMA_VERSION = 1


def build_replay(scenario: Scenario, result: SimulationResult) -> dict[str, Any]:
    times = [p.t for p in result.trajectory]
    tracks = []
    for mo in scenario.moving_obstacles:
        samples = []
        for t in times:
            o = mo.at(t)
            samples.append({"t": t, "x": o.x, "y": o.y})
        tracks.append({"id": mo.id, "kind": mo.kind, "width": mo.width, "height": mo.height,
                       "radius": mo.radius, "samples": samples})
    return {
        "schema_version": SCHEMA_VERSION,
        "scenario": scenario.to_dict(),
        "result": result.to_dict(),
        "moving_obstacle_tracks": tracks,
    }


def export_scenario(name: str, out_dir: Path, seed: int = 42) -> dict[str, Any]:
    scenario = get_scenario(name)
    result = run_simulation(scenario, seed=seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.json"
    path.write_text(json.dumps(build_replay(scenario, result), indent=1))
    return {"id": name, "file": path.name, "seed": seed, "outcome": result.outcome,
            "description": scenario.description}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m worldforge.export",
                                 description="Export simulation replays as JSON.")
    ap.add_argument("--scenario", choices=list_scenarios(), action="append",
                    help="scenario to export (repeatable; default: all)")
    ap.add_argument("--out-dir", default="replays", type=Path)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    names = args.scenario or list_scenarios()
    entries = [export_scenario(n, args.out_dir, args.seed) for n in names]
    (args.out_dir / "index.json").write_text(json.dumps({"replays": entries}, indent=1))
    for e in entries:
        print(f"{args.out_dir / e['file']}: {e['outcome']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
