import { validatePrivilegedHelper } from "./deploy-script.js";

const HOST_ACTIONS = new Set([
  "preflight",
  "port-check",
  "port-listening",
  "systemd-restart",
  "systemd-status",
  "systemd-logs",
  "authorize-observability",
  "docker-build",
  "docker-recreate",
  "docker-status",
  "compose-pull",
  "compose-build",
  "compose-up",
  "compose-restart",
  "compose-status",
  "compose-logs",
  "nginx-logs",
  "nginx-configure",
  "nginx-test-reload",
  "certbot-issue",
  "certbot-dry-run",
  "certbot-certificates",
  "publish-static",
  "rollback-release",
  "database-backup",
  "recovery-config"
]);

const PARAMETER_NAMES = new Set([
  "service", "compose-file", "compose-service", "dockerfile", "image", "container",
  "port", "source", "commit", "deployment", "domain", "include-www", "lines",
  "follow", "strategy", "release", "project-path", "compose-services"
]);

function parameterValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length <= 500 && !value.includes("\0")) return value;
  throw Object.assign(new Error("Parámetro de helper no válido"), { code: "INVALID_HOST_PARAMETER" });
}

export async function runHostAction({ config, deployment, action, parameters = {}, run }) {
  if (!HOST_ACTIONS.has(action)) {
    throw Object.assign(new Error(`Acción host no permitida: ${action}`), { code: "HOST_ACTION_NOT_ALLOWED" });
  }
  const helper = await validatePrivilegedHelper(
    config.JUANOS_HOST_HELPER,
    config.NODE_ENV === "production"
  );
  const helperArgs = [action, "--application", deployment.slug];
  for (const [key, value] of Object.entries(parameters)) {
    if (value === null || value === undefined || value === "") continue;
    if (!PARAMETER_NAMES.has(key)) {
      throw Object.assign(new Error(`Parámetro host no permitido: ${key}`), { code: "HOST_PARAMETER_NOT_ALLOWED" });
    }
    helperArgs.push(`--${key}`, parameterValue(value));
  }
  const useSudo = config.JUANOS_HOST_HELPER_USE_SUDO !== "0";
  const executable = useSudo ? "sudo" : helper;
  const args = useSudo ? ["-n", helper, ...helperArgs] : helperArgs;
  return run(executable, args, {
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
  });
}

export { HOST_ACTIONS };
