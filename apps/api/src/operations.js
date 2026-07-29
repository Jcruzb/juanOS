import { idSchema } from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { writeAudit } from "./audit.js";

export function mergeCertificateInventory(registered, observation, now = new Date()) {
  const byDomain = new Map(registered.map((certificate) => [
    certificate.domain.toLowerCase(),
    certificate
  ]));
  const observed = observation?.certificates || [];
  for (const certificate of observed) {
    for (const domain of certificate.domains || []) {
      const key = domain.toLowerCase();
      const current = byDomain.get(key);
      const expiresAt = certificate.expiresAt || current?.expiresAt || null;
      const daysRemaining = expiresAt
        ? Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 86_400_000)
        : null;
      byDomain.set(key, {
        id: current?.id || `observed:${key}`,
        applicationId: current?.applicationId || null,
        applicationName: current?.applicationName || null,
        domain,
        issuer: certificate.issuer || current?.issuer || null,
        issuedAt: current?.issuedAt || null,
        expiresAt,
        daysRemaining: Number.isFinite(daysRemaining) ? daysRemaining : null,
        autoRenewConfigured: current?.autoRenewConfigured ?? true,
        lastRenewalCheck: current?.lastRenewalCheck || null,
        lastRenewalResult: current?.lastRenewalResult || null,
        error: current?.error || null,
        observedAt: current?.observedAt || now.toISOString()
      });
    }
  }
  return [...byDomain.values()].sort((left, right) => {
    if (!left.expiresAt) return -1;
    if (!right.expiresAt) return 1;
    return new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime();
  });
}

export function createOperationsRouter({ express, db }) {
  const router = express.Router();
  router.get("/overview", async (_request, response, next) => {
    try {
      const [alerts, deployments, disk, recoveries] = await Promise.all([
        db.query(
          `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE severity = 'critical')::int AS critical,
           count(*) FILTER (WHERE severity = 'warning')::int AS warning
           FROM alerts WHERE status = 'open'`
        ),
        db.query(
          `SELECT d.id, d.operation, d.status, d.started_at AS "startedAt",
           p.id AS "applicationId", p.name AS "applicationName"
           FROM deployments d JOIN projects p ON p.id = d.project_id
           ORDER BY d.started_at DESC LIMIT 5`
        ),
        db.query(
          `SELECT status, value, observed_at AS "observedAt"
           FROM system_observations WHERE kind = 'disk'
           ORDER BY observed_at DESC LIMIT 1`
        ),
        db.query(
          `SELECT status, verification_status AS "verificationStatus",
           created_at AS "createdAt" FROM recovery_snapshots
           ORDER BY created_at DESC LIMIT 1`
        )
      ]);
      response.json({
        alerts: alerts.rows[0] || { total: 0, critical: 0, warning: 0 },
        latestDeployments: deployments.rows,
        disk: disk.rows[0] || { status: "unknown", value: null, observedAt: null },
        latestRecovery: recoveries.rows[0] || null
      });
    } catch (error) { next(error); }
  });

  router.get("/alerts", async (request, response, next) => {
    try {
      const status = ["open", "acknowledged", "resolved"].includes(request.query.status)
        ? request.query.status
        : "open";
      const result = await db.query(
        `SELECT a.id, a.application_id AS "applicationId", p.name AS "applicationName",
         a.kind, a.severity, a.status, a.title, a.detail, a.metadata,
         a.first_seen_at AS "firstSeenAt", a.last_seen_at AS "lastSeenAt",
         a.resolved_at AS "resolvedAt"
         FROM alerts a LEFT JOIN projects p ON p.id = a.application_id
         WHERE a.status = $1
         ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          a.last_seen_at DESC`,
        [status]
      );
      response.json({ alerts: result.rows });
    } catch (error) { next(error); }
  });

  router.post("/alerts/:alertId/acknowledge", requireCsrf, async (request, response, next) => {
    try {
      const alertId = idSchema.parse(request.params.alertId);
      const result = await db.query(
        `UPDATE alerts SET status = 'acknowledged' WHERE id = $1 AND status = 'open'
         RETURNING application_id`,
        [alertId]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Alerta no encontrada o ya procesada"), { status: 409 });
      await writeAudit(db, request, {
        action: "alert.acknowledged",
        resourceType: "alert",
        resourceId: alertId,
        metadata: { applicationId: result.rows[0].application_id }
      });
      response.json({ id: alertId, status: "acknowledged" });
    } catch (error) { next(error); }
  });

  router.get("/certificates", async (_request, response, next) => {
    try {
      const [result, inventory] = await Promise.all([
        db.query(
        `SELECT c.id, c.application_id AS "applicationId", p.name AS "applicationName",
         c.domain, c.issuer, c.issued_at AS "issuedAt", c.expires_at AS "expiresAt",
         CASE WHEN c.expires_at IS NULL THEN NULL
          ELSE floor(extract(epoch FROM (c.expires_at - now())) / 86400)::int END AS "daysRemaining",
         c.auto_renew_configured AS "autoRenewConfigured",
         c.last_renewal_check AS "lastRenewalCheck",
         c.last_renewal_result AS "lastRenewalResult", c.error,
         c.observed_at AS "observedAt"
         FROM certificates c JOIN projects p ON p.id = c.application_id
         WHERE p.is_active = true
         ORDER BY c.expires_at NULLS FIRST, c.domain`
        ),
        db.query(
          `SELECT value FROM system_observations
           WHERE kind = 'certificates' ORDER BY observed_at DESC LIMIT 1`
        )
      ]);
      response.json({
        certificates: mergeCertificateInventory(result.rows, inventory.rows[0]?.value)
      });
    } catch (error) { next(error); }
  });

  router.get("/recovery-snapshots", async (_request, response, next) => {
    try {
      const result = await db.query(
        `SELECT id, created_at AS "createdAt", status,
         remote_provider AS "remoteProvider", remote_path AS "remotePath",
         checksum, size, verified_at AS "verifiedAt",
         verification_status AS "verificationStatus",
         juanos_version AS "juanosVersion", encryption, error, verification_error AS "verificationError"
         FROM recovery_snapshots ORDER BY created_at DESC LIMIT 50`
      );
      response.json({ snapshots: result.rows });
    } catch (error) { next(error); }
  });

  router.get("/ports", async (_request, response, next) => {
    try {
      const result = await db.query(
        `SELECT pr.id, pr.application_id AS "applicationId", p.name AS "applicationName",
         pr.port, pr.protocol, pr.status, pr.observed_process AS "observedProcess",
         pr.last_checked_at AS "lastCheckedAt"
         FROM port_reservations pr JOIN projects p ON p.id = pr.application_id
         WHERE pr.status <> 'released' ORDER BY pr.port`
      );
      const occupied = new Set(result.rows.map((row) => row.port));
      const suggested = [];
      for (let port = 3000; port <= 9000 && suggested.length < 10; port += 1) {
        if (!occupied.has(port)) suggested.push(port);
      }
      response.json({ ports: result.rows, suggested });
    } catch (error) { next(error); }
  });

  router.get("/audit", async (_request, response, next) => {
    try {
      const result = await db.query(
        `SELECT id, user_id AS "userId", action, resource_type AS "resourceType",
         resource_id AS "resourceId", metadata, ip_address AS "ipAddress", created_at AS "createdAt"
         FROM audit_logs ORDER BY created_at DESC LIMIT 200`
      );
      response.json({ entries: result.rows });
    } catch (error) { next(error); }
  });
  router.get("/logs", async (_request, response, next) => {
    try {
      const result = await db.query(
        `SELECT d.id, p.name AS project, d.status, d.output_summary AS output,
         d.error_message AS error, d.started_at AS "startedAt"
         FROM deployments d JOIN projects p ON p.id = d.project_id
         ORDER BY d.started_at DESC LIMIT 50`
      );
      response.json({ logs: result.rows });
    } catch (error) { next(error); }
  });
  return router;
}
