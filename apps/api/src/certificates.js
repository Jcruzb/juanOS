export function parseCertbotCertificates(output, now = new Date()) {
  const normalized = String(output).trim().replace(/^\s+/gm, "");
  const blocks = normalized.split(/\n(?=Certificate Name:)/).filter((block) => block.startsWith("Certificate Name:"));
  return blocks.map((text) => {
    const name = capture(text, /Certificate Name:\s*(.+)/);
    const domains = (capture(text, /Domains:\s*(.+)/) || "").split(/\s+/).filter(Boolean);
    const expiryText = capture(text, /Expiry Date:\s*([0-9-]+\s+[0-9:+]+(?:\s*\([^)]+\))?)/);
    const expiryIso = expiryText?.match(/^([0-9-]+\s+[0-9:+]+)/)?.[1]?.replace(" ", "T") || null;
    const expiresAt = expiryIso ? new Date(expiryIso) : null;
    const daysRemaining = expiresAt && !Number.isNaN(expiresAt.getTime())
      ? Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000)
      : null;
    return {
      name,
      domains,
      issuer: capture(text, /Issuer:\s*(.+)/),
      certificatePath: capture(text, /Certificate Path:\s*(.+)/),
      privateKeyPath: capture(text, /Private Key Path:\s*(.+)/),
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      daysRemaining,
      severity: certificateSeverity(daysRemaining)
    };
  });
}

function capture(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || null;
}

export function certificateSeverity(daysRemaining, warningDays = 30, criticalDays = 7) {
  if (daysRemaining === null || daysRemaining === undefined) return "unknown";
  if (daysRemaining <= criticalDays) return "critical";
  if (daysRemaining <= warningDays) return "warning";
  return "ok";
}

export function parseCertbotDryRun(output, exitCode = 0) {
  const text = String(output);
  const success = exitCode === 0
    && /all simulated renewals succeeded|the dry run was successful/i.test(text);
  const failed = [...text.matchAll(/renewal configuration file .*? produced an unexpected error|failed to renew certificate ([^\s]+)/gi)]
    .map((match) => match[1] || match[0]);
  return {
    success,
    failed,
    summary: success
      ? "La renovación simulada terminó correctamente"
      : "La renovación simulada falló o no devolvió una confirmación reconocible"
  };
}
