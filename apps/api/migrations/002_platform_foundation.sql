ALTER TABLE projects
  ADD COLUMN application_type text NOT NULL DEFAULT 'other'
    CHECK (application_type IN ('frontend', 'backend', 'fullstack', 'django', 'other')),
  ADD COLUMN status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'online', 'offline', 'degraded', 'deploying', 'attention')),
  ADD COLUMN is_juanos boolean NOT NULL DEFAULT false,
  ADD COLUMN last_inspected_at timestamptz,
  ADD COLUMN expected_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN observed_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN observed_at timestamptz;

CREATE UNIQUE INDEX projects_one_juanos_idx ON projects (is_juanos) WHERE is_juanos = true;

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'other',
  repository_url text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  current_branch text,
  deployed_commit_sha text,
  last_remote_commit_sha text,
  last_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployment_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  strategy text NOT NULL CHECK (
    strategy IN ('static_nginx', 'pm2', 'systemd', 'docker', 'docker_compose')
  ),
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  service_type text NOT NULL,
  working_directory text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  config jsonb NOT NULL DEFAULT '{}',
  expected_state jsonb NOT NULL DEFAULT '{}',
  observed_state jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, name)
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, name)
);
CREATE UNIQUE INDEX environments_one_default_idx
  ON environments(application_id) WHERE is_default = true;

CREATE TABLE environment_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  service_id uuid REFERENCES application_services(id) ON DELETE CASCADE,
  path text NOT NULL,
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'needs_review', 'validated', 'changed', 'invalid')),
  validated_at timestamptz,
  validated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  content_fingerprint text,
  parser_version text NOT NULL DEFAULT '1',
  last_scanned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (environment_id, service_id, path)
);

CREATE TABLE environment_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_file_id uuid NOT NULL REFERENCES environment_files(id) ON DELETE CASCADE,
  key text NOT NULL,
  is_secret boolean NOT NULL DEFAULT true,
  is_required boolean NOT NULL DEFAULT false,
  is_configured boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'file',
  lifecycle text NOT NULL DEFAULT 'runtime' CHECK (lifecycle IN ('build', 'runtime', 'both')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_file_id, key)
);

ALTER TABLE deployments
  ADD COLUMN environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  ADD COLUMN operation text NOT NULL DEFAULT 'deploy',
  ADD COLUMN source_commit_sha text,
  ADD COLUMN target_commit_sha text,
  ADD COLUMN initiated_by text NOT NULL DEFAULT 'admin',
  ADD COLUMN error_code text,
  ADD COLUMN plan jsonb,
  ADD COLUMN plan_hash text,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN log_path text,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN modifications_started boolean NOT NULL DEFAULT false;

DROP INDEX deployments_one_active_per_project_idx;
CREATE UNIQUE INDEX deployments_one_active_per_project_idx
  ON deployments(project_id)
  WHERE status IN (
    'pending', 'analyzing', 'waiting_confirmation', 'waiting_sudo', 'queued', 'running'
  );

CREATE TABLE deployment_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  action text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  requires_sudo boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  finished_at timestamptz,
  exit_code integer,
  output_summary text,
  error_message text,
  UNIQUE (deployment_id, step_key),
  UNIQUE (deployment_id, position)
);

CREATE TABLE deployment_locks (
  application_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id uuid REFERENCES application_services(id) ON DELETE CASCADE,
  url text NOT NULL,
  expected_status integer NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
  timeout_ms integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 60000),
  retries integer NOT NULL DEFAULT 3 CHECK (retries BETWEEN 0 AND 20),
  interval_seconds integer CHECK (interval_seconds IS NULL OR interval_seconds >= 10),
  response_match text,
  last_status text NOT NULL DEFAULT 'not_checked',
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  issuer text,
  issued_at timestamptz,
  expires_at timestamptz,
  auto_renew_configured boolean NOT NULL DEFAULT false,
  last_renewal_check timestamptz,
  last_renewal_result text,
  error text,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, domain)
);

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  title text NOT NULL,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX alerts_open_idx ON alerts(status, severity, last_seen_at DESC);

CREATE TABLE recovery_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL
    CHECK (status IN ('pending', 'creating', 'uploading', 'available', 'verified', 'failed')),
  remote_provider text,
  remote_path text,
  checksum text,
  size bigint CHECK (size IS NULL OR size >= 0),
  verified_at timestamptz,
  juanos_version text,
  error text,
  manifest jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('jc_project', 'jc_global', 'system_scan')),
  source_path text,
  source_fingerprint text,
  confidence text NOT NULL CHECK (
    confidence IN ('confirmed', 'probable', 'ambiguous', 'not_detected')
  ),
  evidence jsonb NOT NULL DEFAULT '[]',
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_path, source_fingerprint)
);

ALTER TABLE audit_logs
  ADD COLUMN application_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL;

INSERT INTO repositories (
  application_id, provider, repository_url, default_branch, deployed_commit_sha
)
SELECT
  id,
  CASE
    WHEN repository_url ILIKE '%github.com%' THEN 'github'
    WHEN repository_url ILIKE '%gitlab.com%' THEN 'gitlab'
    ELSE 'other'
  END,
  repository_url,
  default_branch,
  (
    SELECT d.commit_sha FROM deployments d
    WHERE d.project_id = projects.id AND d.status = 'succeeded'
    ORDER BY d.finished_at DESC NULLS LAST LIMIT 1
  )
FROM projects
ON CONFLICT (application_id) DO NOTHING;

INSERT INTO deployment_strategies (application_id, strategy, config)
SELECT
  id,
  CASE deployment_type
    WHEN 'docker-compose' THEN 'docker_compose'
    WHEN 'systemd' THEN 'systemd'
  END,
  jsonb_build_object('serviceName', service_name)
FROM projects
ON CONFLICT (application_id) DO NOTHING;

INSERT INTO environments (application_id, name, is_default)
SELECT id, 'production', true FROM projects
ON CONFLICT (application_id, name) DO NOTHING;
