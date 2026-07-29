import argon2 from "argon2";
import fs from "node:fs/promises";
import { z } from "zod";
import { loadConfig } from "@juanos/config";
import { createDatabase } from "../src/db.js";
import { assertProjectPath } from "../src/security.js";

const config = loadConfig();

const authSeedSchema = z.object({
  user: z.object({
    email: z.string().email().max(254).transform((value) => value.toLowerCase()),
    password: z.string().min(16).max(256),
    role: z.literal("admin").default("admin"),
    isActive: z.boolean().default(true)
  })
});

async function loadAuthSeed() {
  if (process.env.AUTH_SEED_FILE) {
    const contents = await fs.readFile(process.env.AUTH_SEED_FILE, "utf8");
    return authSeedSchema.parse(JSON.parse(contents)).user;
  }
  return authSeedSchema.parse({
    user: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      role: "admin",
      isActive: true
    }
  }).user;
}

const seedUser = await loadAuthSeed();
const db = createDatabase(config.DATABASE_URL);
const passwordHash = await argon2.hash(seedUser.password, { type: argon2.argon2id });
await db.query(
  `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, $3, $4)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
   role = EXCLUDED.role, is_active = EXCLUDED.is_active, failed_login_count = 0,
   locked_until = NULL, updated_at = now()`,
  [seedUser.email, passwordHash, seedUser.role, seedUser.isActive]
);
async function seedApplication(input) {
  await db.transaction(async (transaction) => {
    const project = await transaction.query(
      `INSERT INTO projects
        (name, slug, local_path, repository_url, default_branch, deployment_type,
         service_name, application_type, is_juanos, expected_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         repository_url = EXCLUDED.repository_url,
         default_branch = EXCLUDED.default_branch,
         application_type = EXCLUDED.application_type,
         is_juanos = EXCLUDED.is_juanos,
         expected_state = EXCLUDED.expected_state,
         updated_at = now()
       RETURNING id`,
      [
        input.name, input.slug, input.localPath, input.repositoryUrl, input.defaultBranch,
        input.deploymentType, input.serviceName, input.applicationType, input.isJuanOS,
        JSON.stringify({ branch: input.defaultBranch, strategy: input.strategy })
      ]
    );
    const applicationId = project.rows[0].id;
    await transaction.query(
      `INSERT INTO repositories (application_id, provider, repository_url, default_branch)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (application_id) DO UPDATE SET
         repository_url = EXCLUDED.repository_url,
         default_branch = EXCLUDED.default_branch,
         updated_at = now()`,
      [applicationId, input.repositoryUrl.includes("github.com") ? "github" : "other", input.repositoryUrl, input.defaultBranch]
    );
    await transaction.query(
      `INSERT INTO deployment_strategies (application_id, strategy, config)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (application_id) DO UPDATE SET
         strategy = EXCLUDED.strategy, config = EXCLUDED.config, updated_at = now()`,
      [applicationId, input.strategy, JSON.stringify({ serviceName: input.serviceName })]
    );
    await transaction.query(
      `INSERT INTO host_observability_authorizations (application_id, status)
       VALUES ($1,$2)
       ON CONFLICT (application_id) DO NOTHING`,
      [
        applicationId,
        input.isJuanOS
          ? "authorized"
          : ["systemd", "docker_compose"].includes(input.strategy) ? "required" : "not_required"
      ]
    );
    await transaction.query(
      `INSERT INTO environments (application_id, name, is_default)
       VALUES ($1,'production',true) ON CONFLICT (application_id, name) DO NOTHING`,
      [applicationId]
    );
    await transaction.query(
      `INSERT INTO application_services
        (application_id, name, service_type, working_directory, config)
       VALUES ($1,$2,$3,$4,'{}'::jsonb)
       ON CONFLICT (application_id, name) DO UPDATE SET
         service_type = EXCLUDED.service_type,
         working_directory = EXCLUDED.working_directory,
         updated_at = now()`,
      [applicationId, input.serviceName, input.strategy, input.localPath]
    );
    if (input.domain) {
      await transaction.query(
        `INSERT INTO application_domains (application_id, hostname, is_primary)
         VALUES ($1,$2,true)
         ON CONFLICT (application_id, hostname) DO UPDATE SET
          is_primary = true, updated_at = now()`,
        [applicationId, input.domain]
      );
    }
  });
}

if (process.env.JUANOS_PROJECT_PATH && process.env.JUANOS_REPOSITORY_URL) {
  const juanosPath = assertProjectPath(config.PROJECTS_ROOT, process.env.JUANOS_PROJECT_PATH);
  await seedApplication({
    name: "JuanOS",
    slug: "juanos",
    localPath: juanosPath,
    repositoryUrl: process.env.JUANOS_REPOSITORY_URL,
    defaultBranch: process.env.JUANOS_DEFAULT_BRANCH || "main",
    deploymentType: "docker-compose",
    serviceName: "juanos",
    applicationType: "fullstack",
    strategy: "docker_compose",
    isJuanOS: true,
    domain: process.env.JUANOS_DOMAIN || null
  });
}
await db.close();
console.info(`Seed de autenticación aplicado para ${seedUser.email}`);
