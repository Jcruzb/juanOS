CREATE TABLE host_observability_authorizations (
  application_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'required'
    CHECK (status IN ('not_required', 'required', 'queued', 'running', 'authorized', 'failed')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  config jsonb NOT NULL DEFAULT '{}',
  error text,
  requested_at timestamptz,
  started_at timestamptz,
  authorized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO host_observability_authorizations (application_id, status)
SELECT
  p.id,
  CASE
    WHEN p.is_juanos THEN 'authorized'
    WHEN ds.strategy IN ('systemd', 'docker_compose') THEN 'required'
    ELSE 'not_required'
  END
FROM projects p
LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
ON CONFLICT (application_id) DO NOTHING;

CREATE INDEX host_observability_authorizations_queue_idx
  ON host_observability_authorizations(status, requested_at)
  WHERE status = 'queued';
