create table public.experiments (
  id                      uuid primary key default gen_random_uuid(),
  status                  text not null default 'running'
                          check (status in ('running', 'stopped', 'completed', 'failed')),
  phase                   text not null default 'baseline'
                          check (phase in ('baseline', 'analyze', 'generate', 'execute', 'random', 'compare', 'done')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  model_id                text not null,
  initial_scenario        jsonb not null,
  simulation_budget       int not null check (simulation_budget between 1 and 50),
  max_iterations          int not null check (max_iterations between 1 and 10),
  scenarios_per_iteration int not null check (scenarios_per_iteration between 1 and 10),
  base_seed               bigint not null,
  completed_simulations   int not null default 0,
  model_calls             int not null default 0,
  current_iteration       int not null default 0,
  error                   text,
  error_count             int not null default 0,
  lock_until              timestamptz,
  comparison              jsonb
);

create table public.simulation_results (
  id              uuid primary key default gen_random_uuid(),
  experiment_id   uuid not null references public.experiments (id) on delete cascade,
  seq             int not null,
  arm             text not null check (arm in ('baseline', 'ai', 'random')),
  iteration       int not null,
  proposal_index  int,
  name            text,
  hypothesis      text,
  scenario_id     text not null,
  seed            bigint not null,
  params          jsonb not null,
  scenario_config jsonb not null,
  outcome         text not null check (outcome in ('success', 'collision', 'timeout', 'no_path', 'stuck')),
  failure_type    text,
  reason          text not null,
  metrics         jsonb not null,
  collision       jsonb,
  trajectory      jsonb not null,
  replay          jsonb not null,
  created_at      timestamptz not null default now(),
  unique (experiment_id, seq)
);

create table public.ai_analyses (
  id                     uuid primary key default gen_random_uuid(),
  experiment_id          uuid not null references public.experiments (id) on delete cascade,
  kind                   text not null check (kind in ('analysis', 'proposal')),
  iteration              int not null,
  simulation_result_ids  uuid[] not null default '{}',
  failure_hypothesis     text,
  confidence             text check (confidence in ('low', 'medium', 'high')),
  observed_facts         jsonb,
  evidence               jsonb,
  recommendations        jsonb,
  recommended_next_experiment text,
  limitations            jsonb,
  proposed_scenarios     jsonb,
  rejected_proposals     jsonb,
  model_id               text not null,
  usage                  jsonb,
  created_at             timestamptz not null default now()
);

create index simulation_results_experiment_idx on public.simulation_results (experiment_id, seq);
create index simulation_results_arm_idx on public.simulation_results (experiment_id, arm);
create index ai_analyses_experiment_idx on public.ai_analyses (experiment_id, iteration, created_at);
create index experiments_status_created_idx on public.experiments (status, created_at desc);

alter table public.experiments enable row level security;
alter table public.simulation_results enable row level security;
alter table public.ai_analyses enable row level security;

revoke all on public.experiments, public.simulation_results, public.ai_analyses from anon, authenticated;

grant select, insert, update, delete on public.experiments, public.simulation_results, public.ai_analyses to service_role;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger experiments_touch before update on public.experiments
  for each row execute function public.touch_updated_at();
