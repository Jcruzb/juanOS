import { spawn } from "node:child_process";
import { idSchema, gitActionSchema } from "@juanos/shared";
import { writeAudit } from "./audit.js";
import { requireCsrf } from "./auth.js";

const MAX_OUTPUT = 1_000_000;

export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "--no-optional-locks", ...args], {
      shell: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/home/webterminal", GIT_TERMINAL_PROMPT: "0" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr || "Git falló"), { status: 409 })));
  });
}

async function getProject(db, id) {
  const result = await db.query("SELECT local_path FROM projects WHERE id = $1 AND is_active = true", [id]);
  if (!result.rows[0]) throw Object.assign(new Error("Proyecto no encontrado"), { status: 404 });
  return result.rows[0];
}

export function gitArgsForAction(input) {
  switch (input.action) {
    case "fetch": return ["fetch", "--prune"];
    case "pull": return ["pull", "--ff-only"];
    case "push": return ["push"];
    case "stage": return ["add", "--", ...input.paths];
    case "unstage": return ["restore", "--staged", "--", ...input.paths];
    case "commit": return ["commit", "-m", input.message];
    case "create-branch": return ["switch", "-c", input.branch];
    case "switch-branch": return ["switch", input.branch];
    default: throw new Error("Acción Git no permitida");
  }
}

export function createGitRouter({ express, db }) {
  const router = express.Router({ mergeParams: true });
  router.get("/status", async (request, response, next) => {
    try {
      const project = await getProject(db, idSchema.parse(request.params.projectId));
      const [status, compactStatus, log, diff] = await Promise.all([
        runGit(project.local_path, ["status", "--porcelain=v2", "--branch"]),
        runGit(project.local_path, ["status", "--porcelain=v1", "-z"]),
        runGit(project.local_path, ["log", "-10", "--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s"]),
        runGit(project.local_path, ["diff", "--no-ext-diff", "--", "."])
      ]);
      const files = compactStatus.stdout.split("\0").filter(Boolean).map((line) => ({
        index: line[0],
        worktree: line[1],
        path: line.slice(3)
      }));
      response.json({ status: status.stdout, files, commits: log.stdout, diff: diff.stdout });
    } catch (error) { next(error); }
  });
  router.post("/action", requireCsrf, async (request, response, next) => {
    try {
      const input = gitActionSchema.parse(request.body);
      const project = await getProject(db, idSchema.parse(request.params.projectId));
      const result = await runGit(project.local_path, gitArgsForAction(input));
      await writeAudit(db, request, { action: `git.${input.action}`, resourceType: "project", resourceId: request.params.projectId, metadata: input.action === "commit" ? { messageLength: input.message.length } : { action: input.action } });
      response.json(result);
    } catch (error) { next(error); }
  });
  return router;
}
