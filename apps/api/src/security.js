import crypto from "node:crypto";
import path from "node:path";

const SECRET_PATTERNS = [
  /(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*([^\s,;]+)/gi,
  /\b(?:ghp|github_pat|sk|xox[baprs])[-_A-Za-z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)([^@\s/]+)(@)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function timingSafeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function redactSecrets(value, knownSecrets = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  const normalizedSecrets = [...new Set(knownSecrets)]
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of normalizedSecrets) text = text.split(secret).join("[REDACTED]");
  return SECRET_PATTERNS.reduce((clean, pattern, index) => {
    if (index === 0) {
      return clean.replace(pattern, (_match, label) => `${label}=[REDACTED]`);
    }
    if (index === 4) {
      return clean.replace(pattern, (_match, prefix, _password, suffix) => `${prefix}[REDACTED]${suffix}`);
    }
    return clean.replace(pattern, "[REDACTED]");
  }, text);
}

export function assertProjectPath(projectsRoot, candidate) {
  if (candidate.includes("\0")) throw new Error("Ruta no válida");
  const root = path.resolve(projectsRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || resolved === root) {
    throw new Error("La ruta debe estar dentro de PROJECTS_ROOT");
  }
  return resolved;
}

export function requestIp(request) {
  return request.ip?.replace(/^::ffff:/, "") || null;
}
