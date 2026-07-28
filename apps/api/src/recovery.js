import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const RECOVERY_MANIFEST_VERSION = 1;

export function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildRecoveryManifest(root, relativePaths, metadata = {}) {
  const files = [];
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const target = safeBundlePath(root, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Recovery contiene una entrada no regular: ${relativePath}`);
    const content = await fs.readFile(target);
    files.push({ path: relativePath, size: stat.size, checksum: sha256Buffer(content) });
  }
  return {
    version: RECOVERY_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    files,
    ...metadata
  };
}

export async function validateRecoveryManifest(root, manifest) {
  if (!manifest || manifest.version !== RECOVERY_MANIFEST_VERSION || !Array.isArray(manifest.files)) {
    return { valid: false, errors: ["Manifest de recovery no compatible"] };
  }
  const errors = [];
  for (const entry of manifest.files) {
    try {
      if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.checksum)) {
        errors.push("Entrada de manifest no válida");
        continue;
      }
      const target = safeBundlePath(root, entry.path);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("no es un archivo");
      if (stat.size !== entry.size) errors.push(`${entry.path}: tamaño distinto`);
      const checksum = sha256Buffer(await fs.readFile(target));
      if (checksum !== entry.checksum) errors.push(`${entry.path}: checksum distinto`);
    } catch (error) {
      errors.push(`${entry.path}: ${error.message}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function safeBundlePath(root, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Ruta de recovery no válida");
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Ruta fuera del recovery");
  return target;
}

export class RcloneRecoveryProvider {
  constructor({ remoteName, basePath, runner = runProcess }) {
    if (!/^[A-Za-z0-9_-]+$/.test(remoteName)) throw new Error("Remote rclone no válido");
    if (!basePath || basePath.includes("..") || basePath.startsWith("/")) throw new Error("Ruta remota no válida");
    this.remote = `${remoteName}:${basePath.replace(/\/+$/, "")}`;
    this.runner = runner;
  }

  async upload(localEncryptedBundle, remoteFileName) {
    validateRemoteFileName(remoteFileName);
    await this.runner("rclone", ["copyto", localEncryptedBundle, `${this.remote}/${remoteFileName}`, "--checksum"]);
    return this.exists(remoteFileName);
  }

  async download(remoteFileName, localTarget) {
    validateRemoteFileName(remoteFileName);
    await this.runner("rclone", ["copyto", `${this.remote}/${remoteFileName}`, localTarget, "--checksum"]);
    return localTarget;
  }

  async exists(remoteFileName) {
    validateRemoteFileName(remoteFileName);
    const result = await this.runner("rclone", ["lsjson", `${this.remote}/${remoteFileName}`]);
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed.length === 1 : Boolean(parsed);
  }
}

function validateRemoteFileName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.age$/.test(name)) {
    throw new Error("Nombre de snapshot remoto no válido");
  }
}

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1_000_000); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr, exitCode });
      else reject(new Error(`${executable} terminó con código ${exitCode}: ${stderr}`));
    });
  });
}

export { RECOVERY_MANIFEST_VERSION };
