import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const EXCLUDED_NAMES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".env"]);
const PRIVATE_KEY_PATTERN = /(?:^|[\\/._-])(id_rsa|id_ed25519|private.?key)(?:$|[._-])|(?:\.pem|\.p12|\.pfx|\.key)$/i;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateRelativePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Ruta no válida");
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("..") || segments.some((segment) => EXCLUDED_NAMES.has(segment)) || PRIVATE_KEY_PATTERN.test(relativePath)) {
    throw new Error("Ruta bloqueada");
  }
  return segments.join(path.sep);
}

export async function resolveSafePath(projectRoot, relativePath, { forCreate = false } = {}) {
  const safeRelative = validateRelativePath(relativePath);
  const realRoot = await fs.realpath(projectRoot);
  const candidate = path.resolve(realRoot, safeRelative);
  if (!isInside(realRoot, candidate)) throw new Error("Ruta fuera del proyecto");
  if (forCreate) {
    const realParent = await fs.realpath(path.dirname(candidate));
    if (!isInside(realRoot, realParent)) throw new Error("Enlace simbólico fuera del proyecto");
    return path.join(realParent, path.basename(candidate));
  }
  const realCandidate = await fs.realpath(candidate);
  if (!isInside(realRoot, realCandidate)) throw new Error("Enlace simbólico fuera del proyecto");
  return realCandidate;
}

export function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function appearsBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}
