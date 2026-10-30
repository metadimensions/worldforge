# WorldForge

WorldForge finds situations where a robot fails.

It simulates a robot driving through a warehouse. The robot plans a route around shelves and
tries to reach a goal while things like a forklift move around it. Each run ends in one of five
results: success, collision, timeout, no path, or stuck.

On top of the simulator, an AI model (NVIDIA Nemotron) looks at the failed runs, guesses why the
robot failed, and suggests new scenarios that might break it again. The simulator runs those
scenarios, and the results are compared against scenarios picked at random. Every run can be
replayed in 3D in the browser.

![alt text](image.png)

## How it fits together

- `src/worldforge/`: the Python simulator. It is the only thing that decides what happens in a run.
- `web/`: a Next.js app that replays runs in 3D and shows the AI results.
- `supabase/`: the backend. Edge Functions call Nemotron and the simulator, and Postgres stores
  experiments and results.
- `tests/`: Python tests.

## Run the simulator

Requires Python 3.11 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m worldforge.demo --scenario success
python -m worldforge.demo --scenario failure
python -m worldforge.demo --scenario failure --headless
```

The `failure` scenario shows the main problem the project is about: the robot only checks
whether its next step is clear right now, so a forklift crossing the aisle drives into its side.

## Run the 3D viewer

```bash
python -m worldforge.export --out-dir web/public/replays
cd web
npm install
npm run dev
```


## Run the AI testing locally

You need the Supabase CLI, Docker, and a Nebius Token Factory API key.

```bash
WORKER_TOKEN=devtoken python -m worldforge.worker --port 8787

supabase start
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env

cd web && npm run dev
```

Fill in `NEBIUS_API_KEY` and set `SIMULATOR_TOKEN=devtoken` in `supabase/functions/.env`.
Copy `web/.env.example` to `web/.env.local` and set the URL and anon key from `supabase status`.
Then open `/demo?replay=failure`, go to the AI tab, and click "Run AI-guided tests".

The API key only lives in the Supabase function secrets. The browser never sees it.

## Tests

```bash
python -m pytest -q
cd supabase/functions && deno task test
cd web && npm run lint && npm run build
```

