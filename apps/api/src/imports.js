import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireCsrf } from "./auth.js";
import { assertProjectPath } from "./security.js";
import { writeAudit } from "./audit.js";
import {
  discoverApplicationDirectories,
  inspectApplicationDirectory,
  readLegacyGlobalIndex
} from "./discovery.js";

const importSchema = z.object({
  projectPath: z.string().startsWith("/").max(500),
  name: z.string().trim().min(2).max(80).optional(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  repositoryUrl: z.string().max(500).refine((value) => {
    if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(value)) return true;
    try {
      return ["https:", "ssh:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }).optional(),
  applicationType: z.enum(["frontend", "backend", "fullstack", "django", "other"]).optional(),
  strategy: z.enum(["static_nginx", "pm2", "systemd", "docker", "docker_compose"]).optional(),
  confirmAmbiguous: z.boolean().default(false),
  isJuanOS: z.boolean().default(false)
});

function legacyDeploymentType(strategy) {
  return strategy === "docker_compose" || strategy === "docker" ? "docker-compose" : "systemd";
}

function providerFor(repositoryUrl) {
  if (/github\.com/i.test(repositoryUrl)) return "github";
  if (/gitlab\.com/i.test(repositoryUrl)) return "gitlab";
  return "other";
}

export function createImportsRouter({ express, db, config }) {
  const router = express.Router();

  router.get("/discovery", async (_request, response, next) => {
    try {
      const rows = await db.query("SELECT local_path FROM projects WHERE is_active = true");
      const registered = new Set(await Promise.all(
        rows.rows.map((row) => fs.realpath(row.local_path).catch(() => path.resolve(row.local_path)))
      ));
      const candidates = await discoverApplicationDirectories(config.PROJECTS_ROOT, registered);
      if (config.JC_DEPLOY_INDEX_PATH) {
        const legacyEntries = await readLegacyGlobalIndex(config.JC_DEPLOY_INDEX_PATH);
        const byPath = new Map(candidates.map((candidate) => [candidate.projectPath, candidate]));
        for (const legacyEntry of legacyEntries) {
          let boundedPath;
          try {
            boundedPath = assertProjectPath(config.PROJECTS_ROOT, legacyEntry.projectPath);
            boundedPath = await fs.realpath(boundedPath);
          } catch {
            continue;
          }
          const inspectedBase = byPath.get(boundedPath) || await inspectApplicationDirectory(boundedPath);
          const inspected = {
            ...inspectedBase,
            evidence: [{
            source: "jc-global",
            value: config.JC_DEPLOY_INDEX_PATH,
            detail: "Aplicación referenciada por apps.json histórico",
            confidence: "confirmed"
            }, ...inspectedBase.evidence],
            registered: registered.has(boundedPath)
          };
          byPath.set(boundedPath, inspected);
        }
        response.json({ candidates: [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name)) });
        return;
      }
      response.json({ candidates });
    } catch (error) { next(error); }
  });

  router.post("/import", requireCsrf, async (request, response, next) => {
    try {
      const input = importSchema.parse(request.body);
      const boundedPath = assertProjectPath(config.PROJECTS_ROOT, input.projectPath);
      const projectPath = await fs.realpath(boundedPath);
      assertProjectPath(config.PROJECTS_ROOT, projectPath);
      const inspection = await inspectApplicationDirectory(projectPath);
      if (inspection.confidence === "not_detected") {
        throw Object.assign(new Error("No se detectó una aplicación importable"), { status: 422 });
      }
      if ((inspection.confidence === "ambiguous" || inspection.strategy.ambiguous) && !input.confirmAmbiguous) {
        return response.status(409).json({
          error: {
            code: "AMBIGUOUS_IMPORT",
            message: "La detección contiene contradicciones y requiere confirmación",
            details: inspection
          }
        });
      }
      const repositoryUrl = input.repositoryUrl || inspection.repositoryUrl;
      const strategy = input.strategy || inspection.strategy.strategy;
      if (!repositoryUrl || !strategy) {
        throw Object.assign(new Error("Debes confirmar repositorio y estrategia"), { status: 422 });
      }
      const applicationType = input.applicationType || inspection.applicationType;
      const name = input.name || inspection.name;
      const sourceFingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify(inspection.legacy || inspection.evidence))
        .digest("hex");

      const result = await db.transaction(async (transaction) => {
        const created = await transaction.query(
          `INSERT INTO projects
            (name, slug, local_path, repository_url, default_branch, deployment_type,
             service_name, application_type, status, is_juanos, expected_state,
             observed_state, observed_at, last_inspected_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unknown',$9,$10::jsonb,$11::jsonb,now(),now())
           RETURNING id`,
          [
            name, input.slug, projectPath, repositoryUrl, inspection.defaultBranch,
            legacyDeploymentType(strategy), inspection.legacy?.pm2Name || inspection.legacy?.systemdService || input.slug,
            applicationType, input.isJuanOS,
            JSON.stringify({ branch: inspection.defaultBranch, strategy }),
            JSON.stringify({
              branch: inspection.currentBranch,
              headCommit: inspection.headCommit,
              indicators: inspection.indicators
            })
          ]
        );
        const applicationId = created.rows[0].id;
        await transaction.query(
          `INSERT INTO repositories
            (application_id, provider, repository_url, default_branch, current_branch)
           VALUES ($1,$2,$3,$4,$5)`,
          [applicationId, providerFor(repositoryUrl), repositoryUrl, inspection.defaultBranch, inspection.currentBranch]
        );
        await transaction.query(
          `INSERT INTO deployment_strategies (application_id, strategy, config)
           VALUES ($1,$2,$3::jsonb)`,
          [applicationId, strategy, JSON.stringify({
            importedFrom: inspection.legacy ? "jc-deploy" : "system-scan",
            legacy: inspection.legacy || undefined,
            indicators: inspection.indicators,
            composeFile: inspection.indicators.composeFile || undefined,
            services: inspection.indicators.composeServices || undefined
          })]
        );
        await transaction.query(
          `INSERT INTO host_observability_authorizations (application_id, status)
           VALUES ($1,$2)`,
          [applicationId, ["systemd", "docker_compose"].includes(strategy) ? "required" : "not_required"]
        );
        const environment = await transaction.query(
          `INSERT INTO environments (application_id, name, is_default)
           VALUES ($1,'production',true) RETURNING id`,
          [applicationId]
        );
        await transaction.query(
          `INSERT INTO application_services
            (application_id, name, service_type, working_directory, config)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [
            applicationId,
            inspection.legacy?.pm2Name || inspection.legacy?.systemdService || "main",
            strategy,
            projectPath,
            JSON.stringify({ environmentId: environment.rows[0].id })
          ]
        );
        await transaction.query(
          `INSERT INTO import_records
            (application_id, source_type, source_path, source_fingerprint, confidence, evidence, imported_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())`,
          [
            applicationId,
            inspection.legacy ? "jc_project" : "system_scan",
            inspection.legacy ? path.join(projectPath, ".jc-deploy.json") : projectPath,
            sourceFingerprint,
            inspection.confidence,
            JSON.stringify(inspection.evidence)
          ]
        );
        return applicationId;
      });
      await writeAudit(db, request, {
        action: "application.imported",
        resourceType: "application",
        resourceId: result,
        metadata: {
          projectPath,
          confidence: inspection.confidence,
          source: inspection.legacy ? "jc-deploy" : "system-scan"
        }
      });
      response.status(201).json({ applicationId: result, inspection });
    } catch (error) { next(error); }
  });

  return router;
}
