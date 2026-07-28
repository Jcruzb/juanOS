import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(4000),
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  PROJECTS_ROOT: z.string().startsWith("/"),
  DEPLOY_LOGS_DIR: z.string().startsWith("/").default("/var/lib/juanos/deployments"),
  JUANOS_RECOVERY_HELPER: z.string().startsWith("/").optional(),
  JUANOS_SELF_UPDATE_HELPER: z.string().startsWith("/").optional(),
  JUANOS_HOST_HELPER: z.string().startsWith("/").optional(),
  JUANOS_HOST_HELPER_USE_SUDO: z.enum(["0", "1"]).default("1"),
  JUANOS_VERSION: z.string().max(100).default("0.1.0"),
  VPS_PUBLIC_IP: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/).optional(),
  EMBEDDED_WORKER: z.enum(["0", "1"]).default("1"),
  JC_DEPLOY_INDEX_PATH: z.string().startsWith("/").optional(),
  TRUST_PROXY: z.enum(["0", "1"]).default("0")
});

export function loadConfig(source = process.env) {
  return envSchema.parse(source);
}
