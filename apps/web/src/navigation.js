export const applicationTabs = new Set([
  "summary", "deployments", "logs", "variables", "services", "config", "terminal", "files"
]);

export const activityTabs = new Set(["alerts", "deployments", "ssl", "recovery"]);
export const settingsTabs = new Set(["audit", "logs"]);

const sectionPaths = {
  Inicio: "/",
  Proyectos: "/projects",
  Actividad: "/activity/alerts",
  Terminal: "/terminal",
  Ajustes: "/settings/audit"
};

function segmentsFrom(pathname) {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
}

export function routeFromPath(pathname) {
  const segments = segmentsFrom(pathname);
  if (segments.length === 0) return { active: "Inicio", detail: null, subtab: null };
  if (segments[0] === "projects") {
    if (!segments[1]) return { active: "Proyectos", detail: null, subtab: null };
    return {
      active: "Proyectos",
      detail: {
        projectId: segments[1],
        tab: applicationTabs.has(segments[2]) ? segments[2] : "summary"
      },
      subtab: null
    };
  }
  if (segments[0] === "activity") {
    return {
      active: "Actividad",
      detail: null,
      subtab: activityTabs.has(segments[1]) ? segments[1] : "alerts"
    };
  }
  if (segments[0] === "terminal") return { active: "Terminal", detail: null, subtab: null };
  if (segments[0] === "settings") {
    return {
      active: "Ajustes",
      detail: null,
      subtab: settingsTabs.has(segments[1]) ? segments[1] : "audit"
    };
  }
  return { active: "Inicio", detail: null, subtab: null };
}

export function pathForSection(section) {
  return sectionPaths[section] || "/";
}

export function pathForProject(projectId, tab = "summary") {
  const safeTab = applicationTabs.has(tab) ? tab : "summary";
  return `/projects/${encodeURIComponent(projectId)}/${safeTab}`;
}

export function pathForSubtab(section, tab) {
  if (section === "Actividad") {
    return `/activity/${activityTabs.has(tab) ? tab : "alerts"}`;
  }
  if (section === "Ajustes") {
    return `/settings/${settingsTabs.has(tab) ? tab : "audit"}`;
  }
  return pathForSection(section);
}
