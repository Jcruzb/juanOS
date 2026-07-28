import crypto from "node:crypto";

export const ENV_PARSER_VERSION = "1";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY = /(?:secret|password|passwd|token|api_?key|private|credential|database_url|dsn|cookie|session|signing)/i;

export function fingerprintEnvironment(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseEnvironment(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalEol = content.endsWith("\n");
  const rawLines = content.split(/\r?\n/);
  if (hasFinalEol) rawLines.pop();

  const lines = rawLines.map((raw, index) => parseEnvironmentLine(raw, index + 1));
  const issues = lines
    .filter((line) => line.type === "invalid")
    .map((line) => ({ line: line.line, code: line.code, message: line.message }));
  const duplicateKeys = duplicateEnvironmentKeys(lines);
  for (const key of duplicateKeys) {
    issues.push({ line: null, code: "DUPLICATE_KEY", message: `La variable ${key} aparece más de una vez` });
  }

  return {
    parserVersion: ENV_PARSER_VERSION,
    eol,
    hasFinalEol,
    lines,
    issues,
    valid: issues.length === 0
  };
}

function parseEnvironmentLine(raw, line) {
  if (raw.trim() === "") return { type: "blank", raw, line };
  if (/^\s*#/.test(raw)) return { type: "comment", raw, line };

  const match = raw.match(/^(\s*)(?:export\s+)?([^=\s]+)(\s*)=(.*)$/);
  if (!match) {
    return {
      type: "invalid",
      raw,
      line,
      code: "UNSUPPORTED_SYNTAX",
      message: "La línea no es un comentario, espacio o asignación KEY=VALUE compatible"
    };
  }

  const [, indent, key, beforeEquals, value] = match;
  if (!ENV_KEY.test(key)) {
    return {
      type: "invalid",
      raw,
      line,
      code: "INVALID_KEY",
      message: `El nombre ${key} no es válido`
    };
  }

  const trimmed = value.trim();
  const quote = trimmed.startsWith("\"") && trimmed.endsWith("\"")
    ? "\""
    : trimmed.startsWith("'") && trimmed.endsWith("'")
      ? "'"
      : null;

  return {
    type: "assignment",
    raw,
    line,
    key,
    value,
    quote,
    indent,
    beforeEquals,
    isConfigured: value.trim().length > 0,
    isSecret: isSecretEnvironmentKey(key),
    lifecycle: inferEnvironmentLifecycle(key)
  };
}

function duplicateEnvironmentKeys(lines) {
  const seen = new Set();
  const duplicates = new Set();
  for (const line of lines) {
    if (line.type !== "assignment") continue;
    if (seen.has(line.key)) duplicates.add(line.key);
    seen.add(line.key);
  }
  return [...duplicates];
}

export function isSecretEnvironmentKey(key) {
  return SECRET_KEY.test(key);
}

export function inferEnvironmentLifecycle(key) {
  if (/^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_)/.test(key)) return "build";
  if (/^(?:NODE_ENV|DJANGO_SETTINGS_MODULE)$/.test(key)) return "both";
  return "runtime";
}

export function environmentMetadata(parsed) {
  return parsed.lines
    .filter((line) => line.type === "assignment")
    .map((line) => ({
      key: line.key,
      isSecret: line.isSecret,
      isConfigured: line.isConfigured,
      lifecycle: line.lifecycle
    }));
}

export function serializeEnvironment(parsed) {
  const content = parsed.lines.map((line) => line.raw).join(parsed.eol);
  return parsed.hasFinalEol ? `${content}${parsed.eol}` : content;
}

export function updateEnvironmentValue(content, key, value) {
  if (!ENV_KEY.test(key)) throw Object.assign(new Error("Nombre de variable no válido"), { code: "INVALID_ENV_KEY", status: 400 });
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw Object.assign(new Error("El valor debe ocupar una sola línea"), { code: "INVALID_ENV_VALUE", status: 400 });
  }
  const parsed = parseEnvironment(content);
  if (!parsed.valid) {
    throw Object.assign(new Error("El archivo requiere revisión avanzada antes de editarse"), {
      code: "ENV_NEEDS_REVIEW",
      status: 409,
      issues: parsed.issues
    });
  }
  const matches = parsed.lines.filter((line) => line.type === "assignment" && line.key === key);
  if (matches.length > 1) throw Object.assign(new Error("La variable está duplicada"), { code: "DUPLICATE_ENV_KEY", status: 409 });

  if (matches.length === 1) {
    const line = matches[0];
    line.value = value;
    line.raw = `${line.indent}${line.key}${line.beforeEquals}=${value}`;
  } else {
    parsed.lines.push({
      type: "assignment",
      raw: `${key}=${value}`,
      line: parsed.lines.length + 1,
      key,
      value,
      quote: null,
      indent: "",
      beforeEquals: "",
      isConfigured: value.length > 0,
      isSecret: isSecretEnvironmentKey(key),
      lifecycle: inferEnvironmentLifecycle(key)
    });
    parsed.hasFinalEol = true;
  }
  return serializeEnvironment(parsed);
}

export function revealEnvironmentValue(content, key) {
  const parsed = parseEnvironment(content);
  const match = parsed.lines.find((line) => line.type === "assignment" && line.key === key);
  if (!match) throw Object.assign(new Error("Variable no encontrada"), { code: "ENV_KEY_NOT_FOUND", status: 404 });
  return match.value;
}
