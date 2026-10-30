from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .export import build_replay
from .params import (ParamError, build_scenario, classify_failure, parameter_space, random_batch,
                     validate_params, validate_seed)
from .simulator import run_simulation

MAX_BODY = 256 * 1024
MAX_BATCH = 20
MAX_RANDOM = 50

log = logging.getLogger("worldforge.worker")


class BadRequest(Exception):
    def __init__(self, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.details = details or []


def simulate_item(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise BadRequest("each item must be an object")
    unknown = set(item) - {"params", "seed", "scenario_id"}
    if unknown:
        raise BadRequest(f"unsupported fields: {sorted(unknown)}")
    try:
        params = validate_params(item.get("params"))
        seed = validate_seed(item.get("seed", 0))
    except ParamError as e:
        raise BadRequest("invalid scenario parameters", e.errors) from None
    scenario_id = item.get("scenario_id", "forklift_crossing")
    if not isinstance(scenario_id, str) or not 0 < len(scenario_id) <= 80:
        raise BadRequest("scenario_id must be a string of 1-80 characters")
    scenario = build_scenario(params, scenario_id)
    result = run_simulation(scenario, seed=seed)
    return {
        "params": params,
        "seed": seed,
        "scenario": scenario.to_dict(),
        "outcome": result.outcome,
        "reason": result.reason,
        "failure_mode": classify_failure(scenario, result),
        "metrics": result.metrics,
        "collision": result.failure_details and result.failure_details["collision"],
        "duration": result.duration,
        "steps": result.steps,
        "replay": build_replay(scenario, result),
    }


def handle(method: str, path: str, body: Any) -> tuple[int, Any]:
    if method == "GET" and path == "/health":
        return 200, {"ok": True}
    if method == "GET" and path == "/parameter-space":
        return 200, parameter_space()
    if method != "POST":
        return 404, {"error": "not found"}
    if not isinstance(body, dict):
        return 400, {"error": "body must be a JSON object"}
    try:
        if path == "/simulate":
            return 200, simulate_item(body)
        if path == "/simulate-batch":
            items = body.get("items")
            if not isinstance(items, list) or not 0 < len(items) <= MAX_BATCH:
                raise BadRequest(f"items must be a list of 1-{MAX_BATCH} objects")
            return 200, {"results": [simulate_item(i) for i in items]}
        if path == "/validate":
            items = body.get("items")
            if not isinstance(items, list) or len(items) > MAX_BATCH:
                raise BadRequest(f"items must be a list of at most {MAX_BATCH} objects")
            out = []
            for it in items:
                try:
                    params = validate_params(it.get("params") if isinstance(it, dict) else it)
                    out.append({"valid": True, "params": params, "errors": []})
                except ParamError as e:
                    out.append({"valid": False, "params": None, "errors": e.errors})
            return 200, {"results": out}
        if path == "/random-params":
            count, seed = body.get("count"), body.get("seed")
            if isinstance(count, bool) or not isinstance(count, int) or not 0 < count <= MAX_RANDOM:
                raise BadRequest(f"count must be an integer in [1, {MAX_RANDOM}]")
            try:
                seed = validate_seed(seed)
            except ParamError as e:
                raise BadRequest("invalid seed", e.errors) from None
            return 200, {"items": random_batch(count, seed)}
    except BadRequest as e:
        return 400, {"error": str(e), "details": e.details}
    return 404, {"error": "not found"}


class Handler(BaseHTTPRequestHandler):
    server_version = "WorldForgeWorker/1"
    token: str | None = None

    def _send(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        if not self.token or self.path == "/health":
            return True
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, f"Bearer {self.token}")

    def _dispatch(self, method: str) -> None:
        if not self._authorised():
            return self._send(401, {"error": "unauthorised"})
        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._send(413, {"error": "request too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"null")
            except json.JSONDecodeError:
                return self._send(400, {"error": "invalid JSON"})
        try:
            status, payload = handle(method, self.path.split("?")[0], body)
        except Exception:
            log.exception("worker error")
            status, payload = 500, {"error": "internal simulator error"}
        self._send(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def log_message(self, fmt: str, *args: Any) -> None:
        log.info("%s %s", self.address_string(), fmt % args)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m worldforge.worker")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Handler.token = os.environ.get("WORKER_TOKEN") or None
    if not Handler.token:
        log.warning("WORKER_TOKEN is not set: the worker accepts unauthenticated requests")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("WorldForge simulator worker on http://%s:%d", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
