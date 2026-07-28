ALTER TABLE projects
  ADD COLUMN process_status text NOT NULL DEFAULT 'not_checked'
    CHECK (process_status IN ('not_checked', 'online', 'offline', 'degraded', 'unknown')),
  ADD COLUMN http_health_status text NOT NULL DEFAULT 'not_checked'
    CHECK (http_health_status IN ('not_checked', 'healthy', 'unhealthy', 'unknown')),
  ADD COLUMN functional_health_status text NOT NULL DEFAULT 'not_checked'
    CHECK (functional_health_status IN ('not_checked', 'healthy', 'unhealthy', 'unknown'));

ALTER TABLE alerts
  ADD CONSTRAINT alerts_application_kind_unique
  UNIQUE NULLS NOT DISTINCT (application_id, kind);

ALTER TABLE recovery_snapshots
  ADD COLUMN deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  ADD COLUMN local_path text,
  ADD COLUMN encryption text,
  ADD COLUMN verification_error text;

CREATE TABLE application_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  expected_ip inet,
  observed_ips inet[] NOT NULL DEFAULT '{}',
  dns_status text NOT NULL DEFAULT 'not_checked'
    CHECK (dns_status IN ('not_checked', 'valid', 'mismatch', 'unresolved')),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, hostname)
);
CREATE UNIQUE INDEX application_domains_one_primary_idx
  ON application_domains(application_id) WHERE is_primary = true;

CREATE TABLE deployment_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('static_release', 'container_image', 'backup', 'marker')),
  reference text NOT NULL,
  commit_sha text,
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  commit_sha text NOT NULL,
  release_path text NOT NULL,
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'active', 'previous', 'failed', 'removed')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, release_path)
);
CREATE UNIQUE INDEX application_releases_one_active_idx
  ON application_releases(application_id) WHERE status = 'active';

CREATE TABLE database_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  strategy text NOT NULL CHECK (
    strategy IN ('pg_dump_local', 'docker_exec_pg_dump', 'custom_script')
  ),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'verified', 'failed')),
  path text,
  checksum text,
  size bigint CHECK (size IS NULL OR size >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

CREATE TABLE port_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id uuid REFERENCES application_services(id) ON DELETE CASCADE,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol text NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
  status text NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected', 'observed', 'conflict', 'released')),
  observed_process text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX port_reservations_active_idx
  ON port_reservations(port, protocol) WHERE status <> 'released';

CREATE TABLE health_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  health_check_id uuid NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  http_status integer,
  duration_ms integer,
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_observations_recent_idx
  ON health_observations(health_check_id, checked_at DESC);

CREATE TABLE operational_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES deployments(id) ON DELETE CASCADE,
  source text NOT NULL,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_events_recent_idx
  ON operational_events(created_at DESC);

INSERT INTO application_domains (application_id, hostname, is_primary)
SELECT application_id, domain, true
FROM certificates
ON CONFLICT (application_id, hostname) DO NOTHING;
