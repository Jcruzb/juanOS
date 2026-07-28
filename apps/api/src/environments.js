import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { idSchema } from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { writeAudit } from "./audit.js";
import {
  ENV_PARSER_VERSION,
  environmentMetadata,
  fingerprintEnvironment,
  parseEnvironment,
  revealEnvironmentValue,
  updateEnvironmentValue
} from "./environment.js";

const ENV_FILE_NAME = /^\.env(?:\.[A-Za-z0-9_-]+)*$/;
const TEMPLATE_SUFFIX = /\.(?:example|sample|template)$/;
const keySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200);
const updateSchema = z.object({
  key: keySchema,
  value: z.string().max(64_000).refine((value) => !/[\0\r\n]/.test(value)),
  expectedFingerprint: z.string().length(64)
});
const validateSchema = z.object({ fingerprint: z.string().length(64) });

function isEnvironmentFileName(name) {
  return ENV_FILE_NAME.test(name) && !TEMPLATE_SUFFIX.test(name);
}

async function applicationRoot(db, applicationId) {
  const result = await db.query(
    "SELECT id, local_path AS \"localPath\" FROM projects WHERE id = $1 AND is_active = true",
    [applicationId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Aplicación no encontrada"), { status: 404 });
  return result.rows[0];
}

async function safeEnvironmentPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw Object.assign(new Error("Ruta de entorno no válida"), { status: 400 });
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.includes("..") || !isEnvironmentFileName(parts.at(-1))) {
    throw Object.assign(new Error("Solo se permiten archivos .env registrados"), { status: 400 });
  }
  const rootReal = await fs.realpath(root);
  const targetReal = await fs.realpath(path.resolve(rootReal, relativePath));
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw Object.assign(new Error("El archivo sale de la aplicación"), { status: 403 });
  }
  return targetReal;
}

async function discoverAtRoot(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isEnvironmentFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function ensureDefaultEnvironment(db, applicationId) {
  const result = await db.query(
    `INSERT INTO environments (application_id, name, is_default)
     VALUES ($1, 'production', true)
     ON CONFLICT (application_id, name)
     DO UPDATE SET updated_at = now()
     RETURNING id`,
    [applicationId]
  );
  return result.rows[0].id;
}

async function persistEnvironmentScan(db, environmentId, relativePath, content) {
  const fingerprint = fingerprintEnvironment(content);
  const parsed = parseEnvironment(content);
  const desiredStatus = parsed.valid ? "discovered" : "needs_review";
  const fileResult = await db.query(
    `INSERT INTO environment_files
      (environment_id, path, status, content_fingerprint, parser_version, last_scanned_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (environment_id, service_id, path)
     DO UPDATE SET
       status = CASE
         WHEN environment_files.status = 'validated'
          AND environment_files.content_fingerprint <> EXCLUDED.content_fingerprint THEN 'changed'
         WHEN environment_files.status = 'validated' THEN 'validated'
         ELSE EXCLUDED.status
       END,
       content_fingerprint = EXCLUDED.content_fingerprint,
       parser_version = EXCLUDED.parser_version,
       last_scanned_at = now(),
       updated_at = now()
     RETURNING id, status`,
    [environmentId, relativePath, desiredStatus, fingerprint, ENV_PARSER_VERSION]
  );
  const fileId = fileResult.rows[0].id;
  for (const variable of environmentMetadata(parsed)) {
    await db.query(
      `INSERT INTO environment_variables
        (environment_file_id, key, is_secret, is_configured, lifecycle)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (environment_file_id, key)
       DO UPDATE SET is_secret = EXCLUDED.is_secret,
         is_configured = EXCLUDED.is_configured,
         lifecycle = EXCLUDED.lifecycle,
         updated_at = now()`,
      [fileId, variable.key, variable.isSecret, variable.isConfigured, variable.lifecycle]
    );
  }
  return { id: fileId, path: relativePath, status: fileResult.rows[0].status, fingerprint, issues: parsed.issues };
}

async function registeredEnvironmentFile(db, applicationId, fileId) {
  const result = await db.query(
    `SELECT ef.id, ef.environment_id AS "environmentId", ef.path, ef.status,
      ef.content_fingerprint AS "contentFingerprint",
      p.id AS "applicationId", p.local_path AS "localPath"
     FROM environment_files ef
     JOIN environments e ON e.id = ef.environment_id
     JOIN projects p ON p.id = e.application_id
     WHERE ef.id = $1 AND p.id = $2 AND p.is_active = true`,
    [fileId, applicationId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Archivo de entorno no encontrado"), { status: 404 });
  return result.rows[0];
}

export function createEnvironmentsRouter({ express, db }) {
  const router = express.Router({ mergeParams: true });

  router.post("/scan", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const application = await applicationRoot(db, applicationId);
      const environmentId = await ensureDefaultEnvironment(db, applicationId);
      const discovered = [];
      for (const relativePath of await discoverAtRoot(application.localPath)) {
        const target = await safeEnvironmentPath(application.localPath, relativePath);
        const content = await fs.readFile(target, "utf8");
        discovered.push(await persistEnvironmentScan(db, environmentId, relativePath, content));
      }
      await writeAudit(db, request, {
        action: "environment.scanned",
        resourceType: "application",
        resourceId: applicationId,
        metadata: { files: discovered.map((file) => file.path) }
      });
      response.json({ files: discovered });
    } catch (error) { next(error); }
  });

  router.get("/", async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const result = await db.query(
        `SELECT e.id, e.name, e.is_default AS "isDefault",
          COALESCE(json_agg(json_build_object(
            'id', ef.id, 'path', ef.path, 'status', ef.status,
            'contentFingerprint', ef.content_fingerprint,
            'validatedAt', ef.validated_at, 'lastScannedAt', ef.last_scanned_at,
            'variables', (
              SELECT COALESCE(json_agg(json_build_object(
                'key', ev.key, 'isSecret', ev.is_secret, 'isRequired', ev.is_required,
                'isConfigured', ev.is_configured, 'source', ev.source, 'lifecycle', ev.lifecycle
              ) ORDER BY ev.key), '[]'::json)
              FROM environment_variables ev WHERE ev.environment_file_id = ef.id
            )
          ) ORDER BY ef.path) FILTER (WHERE ef.id IS NOT NULL), '[]'::json) AS files
         FROM environments e
         LEFT JOIN environment_files ef ON ef.environment_id = e.id
         WHERE e.application_id = $1
         GROUP BY e.id ORDER BY e.is_default DESC, e.name`,
        [applicationId]
      );
      response.json({ environments: result.rows });
    } catch (error) { next(error); }
  });

  router.post("/files/:fileId/validate", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const fileId = idSchema.parse(request.params.fileId);
      const input = validateSchema.parse(request.body);
      const file = await registeredEnvironmentFile(db, applicationId, fileId);
      const target = await safeEnvironmentPath(file.localPath, file.path);
      const content = await fs.readFile(target, "utf8");
      const fingerprint = fingerprintEnvironment(content);
      const parsed = parseEnvironment(content);
      if (!parsed.valid) throw Object.assign(new Error("El archivo contiene sintaxis que requiere revisión"), { status: 409 });
      if (fingerprint !== input.fingerprint) {
        throw Object.assign(new Error("El archivo cambió durante la revisión"), { status: 409 });
      }
      await db.query(
        `UPDATE environment_files SET status = 'validated', validated_at = now(),
         validated_by = $2, content_fingerprint = $3, updated_at = now() WHERE id = $1`,
        [fileId, request.user.id, fingerprint]
      );
      await writeAudit(db, request, {
        action: "environment.validated",
        resourceType: "environment_file",
        resourceId: fileId,
        metadata: { applicationId, path: file.path, fingerprint }
      });
      response.json({ status: "validated", fingerprint });
    } catch (error) { next(error); }
  });

  router.post("/files/:fileId/reveal", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const fileId = idSchema.parse(request.params.fileId);
      const key = keySchema.parse(request.body.key);
      const file = await registeredEnvironmentFile(db, applicationId, fileId);
      const target = await safeEnvironmentPath(file.localPath, file.path);
      const value = revealEnvironmentValue(await fs.readFile(target, "utf8"), key);
      await writeAudit(db, request, {
        action: "environment.secret_revealed",
        resourceType: "environment_file",
        resourceId: fileId,
        metadata: { applicationId, path: file.path, key }
      });
      response.set("Cache-Control", "no-store").json({ key, value });
    } catch (error) { next(error); }
  });

  router.patch("/files/:fileId/variables", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const fileId = idSchema.parse(request.params.fileId);
      const input = updateSchema.parse(request.body);
      const file = await registeredEnvironmentFile(db, applicationId, fileId);
      const target = await safeEnvironmentPath(file.localPath, file.path);
      const content = await fs.readFile(target, "utf8");
      if (fingerprintEnvironment(content) !== input.expectedFingerprint) {
        throw Object.assign(new Error("El archivo cambió fuera de JuanOS"), { status: 409 });
      }
      const nextContent = updateEnvironmentValue(content, input.key, input.value);
      const temporary = `${target}.juanos-${crypto.randomUUID()}.tmp`;
      const stat = await fs.stat(target);
      await fs.writeFile(temporary, nextContent, { encoding: "utf8", mode: stat.mode & 0o777 });
      await fs.rename(temporary, target);
      const scan = await persistEnvironmentScan(db, file.environmentId, file.path, nextContent);
      await writeAudit(db, request, {
        action: "environment.variable_updated",
        resourceType: "environment_file",
        resourceId: fileId,
        metadata: { applicationId, path: file.path, key: input.key }
      });
      response.json({ status: scan.status, fingerprint: scan.fingerprint });
    } catch (error) { next(error); }
  });

  return router;
}

export { isEnvironmentFileName, safeEnvironmentPath };
