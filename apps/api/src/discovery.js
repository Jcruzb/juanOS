import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git.js";

const COMPOSE_FILES = [
  "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml",
  "compose.production.yml", "docker-compose.production.yml"
];
const MAX_LEGACY_CONFIG_BYTES = 256 * 1024;

async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}

async function readJsonLimited(target) {
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_LEGACY_CONFIG_BYTES) {
    throw new Error("El archivo histórico es demasiado grande o no es regular");
  }
  return JSON.parse(await fs.readFile(target, "utf8"));
}

function evidence(source, value, detail, confidence = "probable") {
  return { source, value, detail, confidence };
}

export function normalizeLegacyType(value) {
  const normalized = String(value || "").toLowerCase();
  if (["front", "frontend", "static"].includes(normalized)) return "frontend";
  if (["back", "backend", "api", "node"].includes(normalized)) return "backend";
  if (["fullstack", "full-stack"].includes(normalized)) return "fullstack";
  if (normalized === "django") return "django";
  return "other";
}

export function sanitizeLegacyMetadata(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeLegacyMetadata(item, depth + 1));
  if (typeof value !== "object") {
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(value)) {
      return "[REDACTED_URL]";
    }
    return value;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)/i.test(key)) continue;
    result[key] = sanitizeLegacyMetadata(item, depth + 1);
  }
  return result;
}

export function inferStrategy(indicators) {
  const strategies = [];
  if (indicators.compose) strategies.push("docker_compose");
  else if (indicators.dockerfile) strategies.push("docker");
  if (indicators.pm2) strategies.push("pm2");
  if (indicators.systemd) strategies.push("systemd");
  if (indicators.staticNginx) strategies.push("static_nginx");
  return {
    strategy: strategies.length === 1 ? strategies[0] : null,
    candidates: strategies,
    ambiguous: strategies.length > 1
  };
}

export function confidenceForInspection({ evidence: items, strategy, repositoryUrl }) {
  if (strategy.ambiguous || !repositoryUrl) return "ambiguous";
  if (items.some((item) => item.source === "jc-deploy")) return "confirmed";
  if (items.length >= 2) return "probable";
  return items.length ? "probable" : "not_detected";
}

export async function inspectApplicationDirectory(projectPath) {
  const stat = await fs.stat(projectPath);
  if (!stat.isDirectory()) throw new Error("La ruta candidata no es un directorio");

  const items = [];
  const packagePath = path.join(projectPath, "package.json");
  const managePath = path.join(projectPath, "manage.py");
  const legacyPath = path.join(projectPath, ".jc-deploy.json");
  const dockerfile = await exists(path.join(projectPath, "Dockerfile"));
  const composeFile = (await Promise.all(
    COMPOSE_FILES.map(async (name) => (await exists(path.join(projectPath, name)) ? name : null))
  )).find(Boolean);
  const composeServices = composeFile
    ? await fs.readFile(path.join(projectPath, composeFile), "utf8")
      .then(parseComposeServices)
      .catch(() => [])
    : [];
  const ecosystemFile = (await exists(path.join(projectPath, "ecosystem.config.cjs")))
    ? "ecosystem.config.cjs"
    : (await exists(path.join(projectPath, "ecosystem.config.js"))) ? "ecosystem.config.js" : null;

  let packageJson = null;
  if (await exists(packagePath)) {
    packageJson = await readJsonLimited(packagePath).catch(() => null);
    items.push(evidence("package", true, "package.json detectado"));
  }
  const django = await exists(managePath);
  if (django) items.push(evidence("django", true, "manage.py detectado", "confirmed"));
  if (dockerfile) items.push(evidence("docker", "Dockerfile", "Dockerfile detectado"));
  if (composeFile) items.push(evidence("docker-compose", composeFile, `${composeFile} detectado`, "confirmed"));
  if (ecosystemFile) items.push(evidence("pm2", ecosystemFile, `${ecosystemFile} detectado`));

  let legacy = null;
  if (await exists(legacyPath)) {
    legacy = await readJsonLimited(legacyPath)
      .then((value) => sanitizeLegacyMetadata(value))
      .catch((error) => ({ parseError: error.message }));
    items.push(evidence("jc-deploy", legacyPath, "Metadata histórica detectada", "confirmed"));
  }

  let repositoryUrl = legacy?.repoUrl || null;
  let currentBranch = legacy?.branch || null;
  let headCommit = null;
  if (await exists(path.join(projectPath, ".git"))) {
    items.push(evidence("git", true, "Repositorio Git detectado", "confirmed"));
    const results = await Promise.allSettled([
      runGit(projectPath, ["remote", "get-url", "origin"]),
      runGit(projectPath, ["branch", "--show-current"]),
      runGit(projectPath, ["rev-parse", "HEAD"]),
      runGit(projectPath, ["status", "--porcelain=v1"])
    ]);
    if (results[0].status === "fulfilled") repositoryUrl = results[0].value.stdout.trim() || repositoryUrl;
    if (results[1].status === "fulfilled") currentBranch = results[1].value.stdout.trim() || currentBranch;
    if (results[2].status === "fulfilled") headCommit = results[2].value.stdout.trim();
    if (results[3].status === "fulfilled" && results[3].value.stdout.trim()) {
      items.push(evidence("git-local-changes", true, "El repositorio contiene cambios locales", "confirmed"));
    }
  }

  const frontendSignals = Boolean(
    packageJson?.dependencies?.react
    || packageJson?.devDependencies?.vite
    || packageJson?.dependencies?.vue
    || packageJson?.dependencies?.["@angular/core"]
  );
  const backendSignals = Boolean(
    packageJson?.dependencies?.express
    || packageJson?.dependencies?.fastify
    || packageJson?.dependencies?.koa
    || ecosystemFile
  );
  let applicationType = normalizeLegacyType(legacy?.type);
  if (applicationType === "other") {
    if (django) applicationType = "django";
    else if (frontendSignals && backendSignals) applicationType = "fullstack";
    else if (frontendSignals) applicationType = "frontend";
    else if (backendSignals) applicationType = "backend";
  }

  const strategy = inferStrategy({
    compose: Boolean(composeFile),
    dockerfile,
    pm2: Boolean(legacy?.pm2Name || ecosystemFile),
    systemd: Boolean(legacy?.systemdService),
    staticNginx: applicationType === "frontend" && Boolean(legacy?.publicDir || legacy?.nginxConfig)
  });
  if (!strategy.strategy && strategy.candidates.length === 0) {
    if (applicationType === "frontend") strategy.strategy = "static_nginx";
    if (applicationType === "django") strategy.strategy = "systemd";
  }

  const result = {
    name: legacy?.appName || packageJson?.name || path.basename(projectPath),
    projectPath,
    applicationType,
    repositoryUrl,
    defaultBranch: legacy?.branch || currentBranch || "main",
    currentBranch,
    headCommit,
    strategy,
    legacy,
    indicators: { dockerfile, composeFile, composeServices, ecosystemFile, django },
    evidence: items
  };
  return { ...result, confidence: confidenceForInspection(result) };
}

export function parseComposeServices(content) {
  const services = [];
  const lines = String(content).split(/\r?\n/);
  let inServices = false;
  let servicesIndent = -1;
  let serviceIndent = -1;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!inServices) {
      if (text === "services:") {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }
    if (indent <= servicesIndent) break;
    if (serviceIndent === -1) serviceIndent = indent;
    if (indent !== serviceIndent) continue;
    const match = text.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:\s*(?:#.*)?)?$/);
    if (match && !services.includes(match[1])) services.push(match[1]);
  }
  return services.slice(0, 100);
}

export async function discoverApplicationDirectories(root, registeredPaths = new Set()) {
  const rootReal = await fs.realpath(root);
  const entries = await fs.readdir(rootReal, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidatePath = path.join(rootReal, entry.name);
    const inspected = await inspectApplicationDirectory(candidatePath).catch((error) => ({
      name: entry.name,
      projectPath: candidatePath,
      applicationType: "other",
      repositoryUrl: null,
      defaultBranch: "main",
      strategy: { strategy: null, candidates: [], ambiguous: false },
      evidence: [evidence("inspection-error", error.message, "No se pudo completar la inspección")],
      confidence: "ambiguous"
    }));
    candidates.push({ ...inspected, registered: registeredPaths.has(candidatePath) });
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseLegacyGlobalIndex(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.apps)) {
    throw new Error("El índice global de JC-Deploy no tiene un array apps");
  }
  return value.apps
    .filter((app) => app && typeof app === "object" && typeof app.projectPath === "string")
    .map((app) => ({
      name: app.appName || path.basename(app.projectPath),
      projectPath: app.projectPath,
      applicationType: normalizeLegacyType(app.type),
      sourcePath: app.metadataPath || null,
      status: app.status || "unknown"
    }));
}

export async function readLegacyGlobalIndex(indexPath) {
  return parseLegacyGlobalIndex(await readJsonLimited(indexPath));
}

export { COMPOSE_FILES, MAX_LEGACY_CONFIG_BYTES };
