CREATE TABLE operational_log_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (
    source IN ('pm2', 'systemd', 'docker_compose', 'nginx_access', 'nginx_error')
  ),
  service_name text,
  line_limit integer NOT NULL CHECK (line_limit IN (100, 500, 1000)),
  follow boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'finished', 'failed', 'cancelled')),
  claimed_by text,
  log_path text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);
CREATE INDEX operational_log_sessions_queue_idx
  ON operational_log_sessions(status, created_at) WHERE status = 'queued';

ALTER TABLE recovery_snapshots
  ADD COLUMN verification_status text NOT NULL DEFAULT 'not_checked'
    CHECK (verification_status IN ('not_checked', 'running', 'valid', 'invalid'));

CREATE TABLE system_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'warning', 'critical', 'unknown')),
  value jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_observations_recent_idx
  ON system_observations(kind, observed_at DESC);

ALTER TABLE projects
  ADD COLUMN state_ignore_until timestamptz,
  ADD COLUMN state_decision_note text;
