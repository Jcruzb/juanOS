import { healthCheckSchema, strategyConfigurationKeys } from "@juanos/shared";

const CONFIG_FIELDS = ["workingDirectory", "pythonVenv", "requirements", "collectstatic", "backupStrategy", "buildOutputDir"];
export const CONFIGURATION_LABELS = {
  healthUrl: "URL de comprobación de salud", healthExpectedStatus: "Estado HTTP esperado",
  defaultBranch: "Rama de despliegue", applicationType: "Tipo de aplicación", strategy: "Estrategia", serviceName: "Servicio principal",
  workingDirectory: "Directorio de trabajo", pythonVenv: "Entorno Python", requirements: "Archivo de dependencias", collectstatic: "Recopilar estáticos Django",
  backupStrategy: "Respaldo previo a migraciones", buildOutputDir: "Carpeta generada del frontend"
};
export function configurationForm(application) {
  const config = application.strategyConfig || {};
  return {
    healthUrl: application.healthCheck?.url || "", healthExpectedStatus: application.healthCheck?.expectedStatus || 200,
    defaultBranch: application.defaultBranch || "main", applicationType: application.applicationType || "other",
    strategy: application.strategy || "systemd", serviceName: application.serviceName || "",
    workingDirectory: config.workingDirectory || ".", pythonVenv: config.pythonVenv || "venv",
    requirements: config.requirements || "requirements.txt", collectstatic: config.collectstatic !== false,
    backupStrategy: config.backupStrategy || "none", buildOutputDir: config.buildOutputDir || "dist"
  };
}
export function configurationChanges(application, form) {
  const current = configurationForm(application);
  const changes = Object.keys(current).filter((key) => current[key] !== form[key]).map((key) => ({ key, label: CONFIGURATION_LABELS[key], before: current[key], after: form[key] }));
  const serviceOverride = application.strategyConfig?.serviceName;
  if (form.strategy === "systemd" && serviceOverride && serviceOverride !== form.serviceName) {
    changes.push({ key: "strategyServiceName", label: "Servicio efectivo de la estrategia", before: serviceOverride, after: form.serviceName });
  }
  return changes;
}
export function configurationPayload(application, form) {
  const current = configurationForm(application);
  const strategyConfig = Object.fromEntries(Object.entries(application.strategyConfig || {}).filter(([key]) => strategyConfigurationKeys.includes(key)));
  for (const key of CONFIG_FIELDS) {
    if (current[key] !== form[key]) strategyConfig[key] = form[key];
  }
  // A configured override must not keep restarting the old service after edit.
  if (form.serviceName !== current.serviceName || (form.strategy === "systemd" && strategyConfig.serviceName && strategyConfig.serviceName !== form.serviceName)) strategyConfig.serviceName = form.serviceName;
  const healthCheck = Object.fromEntries(Object.entries(application.healthCheck || {}).filter(([key]) => Object.hasOwn(healthCheckSchema.shape, key)));
  return {
    confirm: true, expectedUpdatedAt: application.updatedAt,
    defaultBranch: form.defaultBranch, applicationType: form.applicationType,
    strategy: form.strategy, serviceName: form.serviceName, strategyConfig,
    ...(form.healthUrl ? { healthCheck: { ...healthCheck, url: form.healthUrl, expectedStatus: Number(form.healthExpectedStatus) } } : {})
  };
}

export function needsImportedConfigurationReview(application) {
  const config = application.strategyConfig || {};
  return Boolean((config.importedFrom || config.legacy) && !config.configurationReviewedAt);
}

export function configurationReview(application, form) {
  const changes = configurationChanges(application, form);
  const fullReview = needsImportedConfigurationReview(application);
  if (!changes.length && !fullReview) return null;
  const payload = configurationPayload(application, form);
  const settings = Object.entries(payload).filter(([key]) => !["confirm", "expectedUpdatedAt"].includes(key)).map(([key, value]) => ({
    key,
    label: CONFIGURATION_LABELS[key] || ({ strategyConfig: "Ajustes operativos de estrategia", healthCheck: "Comprobación de salud" })[key] || key,
    value: typeof value === "object" ? JSON.stringify(value, null, 2) : value
  }));
  return { changes, payload, fullReview, settings };
}
