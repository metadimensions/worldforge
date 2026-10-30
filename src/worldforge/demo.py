from __future__ import annotations

import argparse
import json
import sys

from .scenarios import get_scenario, list_scenarios
from .simulator import run_simulation


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m worldforge.demo", description="Run a WorldForge scenario and show or export the result.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", default="success", choices=list_scenarios())
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--headless", action="store_true", help="run without a window and print a summary")
    ap.add_argument("--json", metavar="PATH", help="write the full result (trajectory included) to PATH")
    args = ap.parse_args(argv)

    scenario = get_scenario(args.scenario)
    result = run_simulation(scenario, seed=args.seed)

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"scenario": scenario.to_dict(), "result": result.to_dict()}, f, indent=2)

    summary = {
        "scenario": result.scenario_id,
        "seed": result.seed,
        "outcome": result.outcome,
        "reason": result.reason,
        "steps": result.steps,
        "duration": result.duration,
        "metrics": result.metrics,
        "collision": result.failure_details and result.failure_details["collision"],
    }
    print(json.dumps(summary, indent=2))

    if not args.headless:
        try:
            from .visualizer import run_viewer
        except ImportError:
            print("pygame is not installed; rerun with --headless", file=sys.stderr)
            return 1
        run_viewer(args.scenario, seed=args.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
