-- Repair only the unconfigured self-registration created by the original seed.
-- Explicit Compose settings and other applications remain untouched.
UPDATE deployment_strategies ds
SET config = '{"serviceName":"api","composeFile":"docker-compose.yml","services":["api","web","postgres"]}'::jsonb,
    updated_at = now()
FROM projects p
WHERE ds.application_id = p.id AND p.is_juanos = true
  AND ds.strategy = 'docker_compose'
  AND ds.config = '{"serviceName":"juanos"}'::jsonb;
