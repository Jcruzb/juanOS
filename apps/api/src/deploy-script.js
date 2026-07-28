import fs from "node:fs/promises";
import path from "node:path";

export async function validateDeployScript(directory, slug, production = false) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Slug no válido");
  const script = path.join(directory, slug);
  const stat = await fs.stat(script);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error("Ejecutor de despliegue inseguro");
  if (production && stat.uid !== 0) throw new Error("El ejecutor debe pertenecer a root");
  return script;
}

export async function validatePrivilegedHelper(helperPath, production = false) {
  if (!helperPath) {
    throw Object.assign(new Error("El helper privilegiado no está configurado"), {
      code: "HELPER_NOT_CONFIGURED"
    });
  }
  const stat = await fs.stat(helperPath);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (production && stat.uid !== 0)) {
    throw Object.assign(new Error("El helper privilegiado no cumple permisos seguros"), {
      code: "INSECURE_HELPER"
    });
  }
  return helperPath;
}
