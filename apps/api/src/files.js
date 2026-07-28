import fs from "node:fs/promises";
import path from "node:path";
import {
  fileDeleteSchema, fileEntrySchema, fileRenameSchema, fileSearchSchema,
  idSchema, fileWriteSchema, relativePathSchema
} from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { EXCLUDED_NAMES, appearsBinary, contentHash, resolveSafePath, validateRelativePath } from "./project-paths.js";
import { writeAudit } from "./audit.js";

const MAX_FILE_BYTES = 2_000_000;

async function projectRoot(db, id) {
  const result = await db.query("SELECT local_path FROM projects WHERE id = $1 AND is_active = true", [id]);
  if (!result.rows[0]) {
    throw Object.assign(new Error("Proyecto no encontrado"), { status: 404 });
  }
  return result.rows[0].local_path;
}

async function listTree(root, directory = root, depth = 0, budget = { count: 0 }) {
  if (depth > 8 || budget.count > 3000) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (EXCLUDED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    budget.count += 1;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    try { validateRelativePath(relative); } catch { continue; }
    if (entry.isDirectory()) nodes.push({ name: entry.name, path: relative, type: "directory", children: await listTree(root, absolute, depth + 1, budget) });
    else nodes.push({ name: entry.name, path: relative, type: "file" });
    if (budget.count > 3000) break;
  }
  return nodes;
}

async function searchFiles(root, query, maxResults) {
  const matches = [];
  const needle = query.toLocaleLowerCase();
  async function visit(directory, depth = 0) {
    if (depth > 8 || matches.length >= maxResults) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults || EXCLUDED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      try { validateRelativePath(relative); } catch { continue; }
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(absolute);
      if (appearsBinary(buffer)) continue;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index].toLocaleLowerCase().includes(needle)) {
          matches.push({ path: relative, line: index + 1, preview: lines[index].trim().slice(0, 240) });
        }
      }
    }
  }
  await visit(root);
  return matches;
}

export function createFilesRouter({ express, db }) {
  const router = express.Router({ mergeParams: true });

  router.get("/tree", async (request, response, next) => {
    try {
      const root = await fs.realpath(await projectRoot(db, idSchema.parse(request.params.projectId)));
      response.json({ tree: await listTree(root) });
    } catch (error) { next(error); }
  });

  router.get("/content", async (request, response, next) => {
    try {
      const root = await projectRoot(db, idSchema.parse(request.params.projectId));
      const file = await resolveSafePath(root, relativePathSchema.parse(request.query.path));
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return response.status(413).json({ error: { code: "FILE_TOO_LARGE", message: "Archivo no permitido o demasiado grande" } });
      const buffer = await fs.readFile(file);
      if (appearsBinary(buffer)) return response.status(415).json({ error: { code: "BINARY_FILE", message: "Los binarios no se muestran" } });
      const content = buffer.toString("utf8");
      response.json({ content, hash: contentHash(content), size: stat.size });
    } catch (error) { next(error); }
  });

  router.put("/content", requireCsrf, async (request, response, next) => {
    try {
      const input = fileWriteSchema.parse(request.body);
      const root = await projectRoot(db, idSchema.parse(request.params.projectId));
      let file;
      let previous = "";
      let exists = false;
      try {
        file = await resolveSafePath(root, input.path);
        previous = await fs.readFile(file, "utf8");
        exists = true;
      } catch (error) {
        if (!String(error.message).includes("ENOENT")) throw error;
        file = await resolveSafePath(root, input.path, { forCreate: true });
      }
      if (input.expectedHash && contentHash(previous) !== input.expectedHash) {
        return response.status(409).json({ error: { code: "FILE_CHANGED", message: "El archivo cambió desde que lo abriste" } });
      }
      await fs.writeFile(file, input.content, { encoding: "utf8", flag: exists ? "w" : "wx", mode: 0o640 });
      await writeAudit(db, request, { action: "file.saved", resourceType: "project", resourceId: request.params.projectId, metadata: { path: input.path, bytes: Buffer.byteLength(input.content) } });
      response.json({ hash: contentHash(input.content) });
    } catch (error) { next(error); }
  });

  router.get("/search", async (request, response, next) => {
    try {
      const input = fileSearchSchema.parse({ query: request.query.q, maxResults: request.query.limit || 100 });
      const root = await fs.realpath(await projectRoot(db, idSchema.parse(request.params.projectId)));
      response.json({ matches: await searchFiles(root, input.query, input.maxResults) });
    } catch (error) { next(error); }
  });

  router.post("/entry", requireCsrf, async (request, response, next) => {
    try {
      const input = fileEntrySchema.parse(request.body);
      const root = await projectRoot(db, idSchema.parse(request.params.projectId));
      const target = await resolveSafePath(root, input.path, { forCreate: true });
      if (input.type === "directory") await fs.mkdir(target, { mode: 0o750 });
      else await fs.writeFile(target, "", { flag: "wx", mode: 0o640 });
      await writeAudit(db, request, { action: `${input.type}.created`, resourceType: "project", resourceId: request.params.projectId, metadata: { path: input.path } });
      response.status(201).json({ path: input.path });
    } catch (error) { next(error); }
  });

  router.patch("/entry", requireCsrf, async (request, response, next) => {
    try {
      const input = fileRenameSchema.parse(request.body);
      const root = await projectRoot(db, idSchema.parse(request.params.projectId));
      const source = await resolveSafePath(root, input.path);
      const target = await resolveSafePath(root, input.newPath, { forCreate: true });
      if (target.startsWith(`${source}${path.sep}`)) throw Object.assign(new Error("No se puede mover una carpeta dentro de sí misma"), { status: 400 });
      await fs.rename(source, target);
      await writeAudit(db, request, { action: "file.renamed", resourceType: "project", resourceId: request.params.projectId, metadata: { from: input.path, to: input.newPath } });
      response.json({ path: input.newPath });
    } catch (error) { next(error); }
  });

  router.delete("/entry", requireCsrf, async (request, response, next) => {
    try {
      const input = fileDeleteSchema.parse(request.body);
      const root = await projectRoot(db, idSchema.parse(request.params.projectId));
      const target = await resolveSafePath(root, input.path);
      await fs.rm(target, { recursive: true, force: false });
      await writeAudit(db, request, { action: "file.deleted", resourceType: "project", resourceId: request.params.projectId, metadata: { path: input.path } });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
