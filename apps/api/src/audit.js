import { redactSecrets, requestIp } from "./security.js";

export async function writeAudit(db, request, entry) {
  let metadata = {};
  try {
    metadata = JSON.parse(redactSecrets(entry.metadata || {}));
  } catch {
    metadata = { redacted: true };
  }
  await db.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      entry.userId || request.user?.id || null,
      entry.action,
      entry.resourceType,
      entry.resourceId || null,
      JSON.stringify(metadata),
      requestIp(request)
    ]
  );
}
