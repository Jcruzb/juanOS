import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256)
});

const safeCommand = z
  .string()
  .max(500)
  .regex(/^[\w@./:=,+\-\s]*$/, "El comando contiene caracteres no permitidos")
  .optional()
  .default("");

export const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  localPath: z.string().startsWith("/").max(500),
  repositoryUrl: z.string().max(500).refine((value) => {
    if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(value)) return true;
    try {
      return ["https:", "ssh:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "URL de repositorio no válida"),
  defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/).max(200).default("main"),
  installCommand: safeCommand,
  buildCommand: safeCommand,
  deployCommand: safeCommand,
  deploymentType: z.enum(["docker-compose", "systemd"]),
  serviceName: z.string().regex(/^[A-Za-z0-9_.@-]+$/).max(200),
  applicationType: z.enum(["frontend", "backend", "fullstack", "django", "other"]).default("other"),
  strategy: z.enum(["static_nginx", "pm2", "systemd", "docker", "docker_compose"]).optional(),
  strategyConfig: z.object({
    workingDirectory: relativeConfigPath().default("."),
    packageManager: z.enum(["npm", "yarn", "pnpm"]).optional(),
    hasBuild: z.boolean().default(true),
    buildOutputDir: relativeConfigPath().default("dist"),
    frontendPath: relativeConfigPath().optional(),
    backendPath: relativeConfigPath().optional(),
    composeFile: relativeConfigPath().optional(),
    dockerfile: relativeConfigPath().optional(),
    imageName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(200).optional(),
    containerName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(200).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    ecosystemFile: relativeConfigPath().optional(),
    processName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/).max(200).optional(),
    serviceName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/).max(200).optional(),
    nginx: z.object({ enabled: z.boolean().default(false) }).optional(),
    ssl: z.object({
      activate: z.boolean().default(false),
      domain: hostnameSchema().optional(),
      includeWww: z.boolean().default(false)
    }).optional()
  }).optional(),
  domain: hostnameSchema().optional(),
  healthCheck: z.object({
    url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().min(100).max(60_000).default(5000),
    retries: z.number().int().min(0).max(10).default(3),
    responseMatch: z.string().max(500).optional()
  }).optional(),
  isJuanOS: z.boolean().default(false)
});

function relativeConfigPath() {
  return z.string().max(300).refine(
    (value) => value && !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"),
    "Ruta de configuración no válida"
  );
}

function hostnameSchema() {
  return z.string().max(253).regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    "Dominio no válido"
  );
}

export const idSchema = z.string().uuid();

export const relativePathSchema = z.string().max(500).refine(
  (value) => value !== "" && !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"),
  "Ruta relativa no válida"
);

export const fileWriteSchema = z.object({
  path: relativePathSchema,
  content: z.string().max(2_000_000),
  expectedHash: z.string().length(64).optional()
});

export const fileEntrySchema = z.object({
  path: relativePathSchema,
  type: z.enum(["file", "directory"])
});

export const fileRenameSchema = z.object({
  path: relativePathSchema,
  newPath: relativePathSchema
});

export const fileDeleteSchema = z.object({
  path: relativePathSchema,
  confirm: z.literal(true)
});

export const fileSearchSchema = z.object({
  query: z.string().trim().min(2).max(100),
  maxResults: z.coerce.number().int().min(1).max(200).default(100)
});

export const gitActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fetch") }),
  z.object({ action: z.literal("pull") }),
  z.object({ action: z.literal("push") }),
  z.object({ action: z.literal("stage"), paths: z.array(relativePathSchema).min(1).max(100) }),
  z.object({ action: z.literal("unstage"), paths: z.array(relativePathSchema).min(1).max(100) }),
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("create-branch"), branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) }),
  z.object({ action: z.literal("switch-branch"), branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) })
]);

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional()
  })
});
