import crypto from "node:crypto";

export const DEPLOYMENT_PLAN_VERSION = 1;
export const PLAN_ACTIONS = new Set([
  "recovery_snapshot",
  "recovery_verify",
  "preflight_system",
  "port_check",
  "git_clone",
  "git_status",
  "git_fetch",
  "git_compare",
  "git_pull",
  "package_install",
  "package_build",
  "python_install",
  "database_backup",
  "django_migrate",
  "django_collectstatic",
  "static_publish",
  "pm2_reload",
  "systemd_restart",
  "docker_build",
  "docker_recreate",
  "docker_compose_pull",
  "docker_compose_build",
  "docker_compose_up",
  "docker_compose_restart",
  "nginx_validate_reload",
  "nginx_configure",
  "certbot_issue",
  "certbot_dry_run",
  "dns_validate",
  "http_port_validate",
  "deployed_marker",
  "rollback_release",
  "self_update",
  "health_check"
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function deploymentPlanHash(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(plan))).digest("hex");
}

function step(stepKey, name, action, input = {}, requiresSudo = false) {
  return { stepKey, name, action, input, requiresSudo };
}

export function buildDeploymentPlan(application, operation) {
  if (!["deploy", "update", "repair", "restart", "ssl_test", "recovery", "recovery_test", "rollback"].includes(operation)) {
    throw Object.assign(new Error("Operación no soportada"), { code: "UNSUPPORTED_OPERATION" });
  }
  const steps = [];
  const warnings = [];
  const isUpdateLike = operation === "deploy" || operation === "update" || operation === "repair";
  const config = application.strategyConfig || {};

  if (operation === "recovery") {
    steps.push(step("recovery", "Crear y verificar recovery cifrado", "recovery_snapshot", {
      reason: "manual"
    }));
    return finalizePlan(application, operation, steps, warnings);
  }
  if (operation === "recovery_test") {
    if (!application.recoverySnapshot) {
      throw Object.assign(new Error("No existe un recovery remoto disponible para verificar"), {
        code: "RECOVERY_NOT_AVAILABLE"
      });
    }
    steps.push(step("recovery-verify", "Descargar, descifrar y verificar recovery", "recovery_verify", {
      snapshotId: application.recoverySnapshot.id,
      remotePath: application.recoverySnapshot.remotePath,
      checksum: application.recoverySnapshot.checksum
    }, true));
    return finalizePlan(application, operation, steps, warnings);
  }
  if (operation === "ssl_test") {
    steps.push(step("certbot-dry-run", "Probar renovación Certbot", "certbot_dry_run", {
      domain: application.domain || config.domain || null
    }, true));
    return finalizePlan(application, operation, steps, warnings);
  }
  if (operation === "rollback") {
    if (application.strategy !== "static_nginx") {
      throw Object.assign(new Error(
        "Rollback automático solo está disponible para frontend estático con releases; no incluye datos."
      ), { code: "ROLLBACK_NOT_AVAILABLE" });
    }
    steps.push(step("rollback", "Activar última release funcional", "rollback_release", {
      strategy: application.strategy
    }, true));
    appendHealthStep(steps, warnings, application.healthCheck);
    return finalizePlan(application, operation, steps, warnings);
  }

  if (application.isJuanOS && isUpdateLike) {
    steps.push(step(
      "recovery",
      "Crear recovery previo de JuanOS",
      "recovery_snapshot",
      { reason: `${operation}:juanos` },
      true
    ));
  }
  if (isUpdateLike) {
    steps.push(step("preflight", "Comprobar herramientas y configuración", "preflight_system", {
      strategy: application.strategy,
      applicationType: application.applicationType
    }));
    if (config.port) {
      steps.push(step("port-check", `Comprobar puerto ${config.port}`, "port_check", {
        port: config.port
      }));
    }
    if (application.repositoryExists === false) {
      steps.push(step("git-clone", "Clonar repositorio", "git_clone", {
        repositoryUrl: application.repositoryUrl,
        branch: application.defaultBranch
      }));
    } else {
      steps.push(step("git-status", "Comprobar cambios locales", "git_status"));
      steps.push(step("git-fetch", "Actualizar referencias remotas", "git_fetch"));
      steps.push(step("git-compare", "Comparar commits", "git_compare", {
        branch: application.defaultBranch
      }));
      steps.push(step("git-pull", "Actualizar copia de trabajo", "git_pull", {
        branch: application.defaultBranch
      }));
    }
  }

  if (application.isJuanOS && isUpdateLike) {
    steps.push(step("self-update", "Preparar y activar release JuanOS", "self_update", {
      operation,
      strategy: application.strategy
    }, true));
  } else {
    appendStrategySteps(steps, application, operation);
  }

  if (isUpdateLike) {
    steps.push(step("deployed-marker", "Registrar artefacto desplegado", "deployed_marker", {
      strategy: application.strategy
    }));
  }
  appendHealthStep(steps, warnings, application.healthCheck);

  return finalizePlan(application, operation, steps, warnings);
}

function finalizePlan(application, operation, steps, warnings) {
  const plan = {
    version: DEPLOYMENT_PLAN_VERSION,
    applicationId: application.id,
    applicationSlug: application.slug,
    operation,
    strategy: application.strategy,
    sourceCommitSha: application.currentCommit || null,
    targetBranch: application.defaultBranch,
    isJuanOS: Boolean(application.isJuanOS),
    warnings,
    steps
  };
  assertSafeDeploymentPlan(plan);
  return { plan, hash: deploymentPlanHash(plan) };
}

function appendStrategySteps(steps, application, operation) {
  const config = application.strategyConfig || {};
  const strategy = application.strategy;
  const applicationType = application.applicationType;
  if (operation === "restart") {
    appendRestartStep(steps, strategy, config);
    return;
  }

  if (strategy === "docker_compose") {
    if (operation === "update" && config.pullImages) {
      steps.push(step("compose-pull", "Descargar imágenes", "docker_compose_pull", {
        composeFile: config.composeFile || "compose.yml"
      }, true));
    }
    steps.push(step("compose-build", "Construir servicios Docker Compose", "docker_compose_build", {
      composeFile: config.composeFile || "compose.yml"
    }, true));
    steps.push(step("compose-up", "Crear o actualizar servicios Docker Compose", "docker_compose_up", {
      composeFile: config.composeFile || "compose.yml"
    }, true));
    return;
  }
  if (strategy === "docker") {
    steps.push(step("docker-build", "Construir imagen Docker", "docker_build", {
      dockerfile: config.dockerfile || "Dockerfile",
      imageName: config.imageName || application.slug
    }, true));
    steps.push(step("docker-recreate", "Recrear contenedor Docker", "docker_recreate", {
      containerName: config.containerName || application.slug,
      imageName: config.imageName || application.slug,
      port: config.port || null
    }, true));
    return;
  }

  if (applicationType === "fullstack" && config.frontendPath) {
    appendNodeBuildSteps(steps, "frontend", config.frontendPath, config.frontendPackageManager, true);
    appendNodeBuildSteps(
      steps,
      "backend",
      config.backendPath || ".",
      config.backendPackageManager || config.packageManager,
      Boolean(config.backendBuild)
    );
    steps.push(step("publish-static", "Publicar frontend por release", "static_publish", {
      workingDirectory: config.frontendPath,
      outputDirectory: config.buildOutputDir || "dist"
    }, true));
  } else if (applicationType === "django") {
    steps.push(step("python-install", "Instalar dependencias Python", "python_install", {
      workingDirectory: config.workingDirectory || ".",
      venv: config.pythonVenv || "venv",
      requirements: config.requirements || "requirements.txt"
    }));
    if (config.backupStrategy && config.backupStrategy !== "none") {
      steps.push(step("database-backup", "Crear backup previo de base de datos", "database_backup", {
        strategy: config.backupStrategy
      }, config.backupStrategy !== "pg_dump_local"));
    }
    steps.push(step("django-migrate", "Ejecutar migraciones Django", "django_migrate", {
      workingDirectory: config.workingDirectory || ".",
      venv: config.pythonVenv || "venv"
    }));
    if (config.collectstatic !== false) {
      steps.push(step("django-collectstatic", "Recopilar archivos estáticos", "django_collectstatic", {
        workingDirectory: config.workingDirectory || ".",
        venv: config.pythonVenv || "venv"
      }));
    }
  } else {
    appendNodeBuildSteps(steps, "application", config.workingDirectory || ".", config.packageManager, Boolean(config.hasBuild ?? true));
  }

  if (strategy === "static_nginx") {
    if (applicationType !== "fullstack") {
      steps.push(step("publish-static", "Publicar frontend por release", "static_publish", {
        workingDirectory: config.workingDirectory || ".",
        outputDirectory: config.buildOutputDir || "dist"
      }, true));
    }
  } else if (strategy === "pm2") {
    steps.push(step("pm2-reload", "Recargar aplicación con PM2", "pm2_reload", {
      ecosystemFile: config.ecosystemFile || "ecosystem.config.cjs",
      processName: config.processName || application.slug
    }));
  } else if (strategy === "systemd") {
    steps.push(step("systemd-restart", "Reiniciar unidad systemd", "systemd_restart", {
      serviceName: config.serviceName || application.serviceName
    }, true));
  }

  if (config.nginx?.enabled) {
    steps.push(step("nginx-configure", "Generar vhost Nginx desde política", "nginx_configure", {}, true));
    steps.push(step("nginx-reload", "Validar y recargar Nginx", "nginx_validate_reload", {}, true));
  }
  if (config.ssl?.activate) {
    steps.push(step("dns-validate", "Validar DNS contra la IP de la VPS", "dns_validate", {
      domain: config.ssl.domain || application.domain
    }));
    steps.push(step("http-port", "Comprobar que el puerto 80 está escuchando", "http_port_validate", {
      port: 80
    }, true));
    steps.push(step("certbot-issue", "Activar certificado SSL", "certbot_issue", {
      domain: config.ssl.domain || application.domain,
      includeWww: Boolean(config.ssl.includeWww)
    }, true));
  }
}

function appendNodeBuildSteps(steps, prefix, workingDirectory, packageManager = null, hasBuild = true) {
  steps.push(step(`${prefix}-install`, `Instalar dependencias de ${prefix}`, "package_install", {
    workingDirectory,
    packageManager
  }));
  if (hasBuild) {
    steps.push(step(`${prefix}-build`, `Construir ${prefix}`, "package_build", {
      workingDirectory,
      packageManager,
      scriptName: "build"
    }));
  }
}

function appendRestartStep(steps, strategy, config) {
  if (strategy === "pm2") {
    steps.push(step("pm2-reload", "Reiniciar proceso PM2 con entorno actualizado", "pm2_reload", {
      ecosystemFile: config.ecosystemFile || "ecosystem.config.cjs",
      processName: config.processName
    }));
  } else if (strategy === "systemd") {
    steps.push(step("systemd-restart", "Reiniciar unidad systemd", "systemd_restart", {
      serviceName: config.serviceName
    }, true));
  } else if (strategy === "docker_compose") {
    steps.push(step("compose-restart", "Reiniciar servicios Docker Compose", "docker_compose_restart", {
      composeFile: config.composeFile || "compose.yml"
    }, true));
  } else if (strategy === "docker") {
    steps.push(step("docker-recreate", "Recrear contenedor Docker", "docker_recreate", {
      containerName: config.containerName,
      imageName: config.imageName,
      port: config.port || null
    }, true));
  } else {
    steps.push(step("nginx-reload", "Validar y recargar Nginx", "nginx_validate_reload", {}, true));
  }
}

function appendHealthStep(steps, warnings, healthCheck) {
  if (healthCheck) {
    steps.push(step("health", "Comprobar salud HTTP", "health_check", {
      id: healthCheck.id || null,
      url: healthCheck.url,
      expectedStatus: healthCheck.expectedStatus,
      timeoutMs: healthCheck.timeoutMs,
      retries: healthCheck.retries,
      responseMatch: healthCheck.responseMatch
    }));
  } else {
    warnings.push({
      code: "HEALTH_NOT_CONFIGURED",
      message: "No hay health check configurado; el resultado no se marcará como saludable."
    });
  }
}

export function assertSafeDeploymentPlan(plan) {
  if (!plan || plan.version !== DEPLOYMENT_PLAN_VERSION || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw Object.assign(new Error("Plan no válido"), { code: "INVALID_PLAN" });
  }
  const keys = new Set();
  for (const current of plan.steps) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(current.stepKey) || keys.has(current.stepKey)) {
      throw Object.assign(new Error("El plan contiene pasos duplicados o inválidos"), { code: "INVALID_PLAN_STEP" });
    }
    if (!PLAN_ACTIONS.has(current.action)) {
      throw Object.assign(new Error(`Acción de plan no permitida: ${current.action}`), { code: "UNSAFE_PLAN_ACTION" });
    }
    if (containsCommandLikeInput(current.input)) {
      throw Object.assign(new Error("El plan contiene comandos arbitrarios"), { code: "UNSAFE_PLAN_INPUT" });
    }
    keys.add(current.stepKey);
  }
  if (plan.isJuanOS && ["deploy", "update", "repair"].includes(plan.operation)) {
    if (plan.steps[0].action !== "recovery_snapshot" || !plan.steps.some((item) => item.action === "self_update")) {
      throw Object.assign(new Error("Una actualización de JuanOS exige recovery y activación externa"), {
        code: "JUANOS_SELF_PROTECTION"
      });
    }
  }
  return plan;
}

function containsCommandLikeInput(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    if (/^(?:command|executable|args|shell)$/i.test(key)) return true;
    return item && typeof item === "object" ? containsCommandLikeInput(item) : false;
  });
}
