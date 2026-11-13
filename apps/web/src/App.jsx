import ProjectConfiguration from "./ProjectConfiguration.jsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Activity, ArrowUpRight, Braces, ChevronRight, CircleDot, Clock3,
  Code2, FileCode2, FilePlus2, FolderGit2, FolderPlus, GitBranch, GitCommitHorizontal,
  Import, LogOut, Pencil, Plus, RefreshCw, Rocket, Search, Server,
  Settings, ShieldCheck, TerminalSquare, Trash2, UploadCloud, Wifi, AlertTriangle, Eye, EyeOff,
  Bell, LockKeyhole, HardDrive, Pause, Play, Copy, ArrowLeft, X, Layers3
} from "lucide-react";
import { api, onUnauthorized, setCsrfToken } from "./api.js";
import {
  pathForProject, pathForSection, pathForSubtab, routeFromPath
} from "./navigation.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

function relativeTime(value) {
  if (!value) return "sin fecha";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "sin fecha";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  /** @type {Array<[number, Intl.RelativeTimeFormatUnit]>} */
  const ranges = [
    [60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"]
  ];
  let amount = seconds;
  /** @type {Intl.RelativeTimeFormatUnit} */
  let unit = "second";
  for (const [limit, nextUnit] of ranges) {
    unit = nextUnit;
    if (Math.abs(amount) < limit) break;
    amount = Math.round(amount / limit);
  }
  if (unit === "month" && Math.abs(amount) >= 12) {
    amount = Math.round(amount / 12);
    unit = "year";
  }
  return new Intl.RelativeTimeFormat("es", { numeric: "auto" }).format(amount, unit);
}

function Brand({ compact = false, productOnly = false }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""} ${productOnly ? "product-brand-only" : ""}`}>
      {!productOnly && <img
          className={compact ? "brand-app-mark" : "brand-signature"}
          src={compact ? "/brand/jc-mark.svg" : "/brand/juan-cruz-logo-dark.svg"}
          alt={compact ? "" : "Juan Cruz — Consultor senior tecnólogo"}
          aria-hidden={compact || undefined}
        />}
      <div className="product-lockup">
        <strong>JuanOS</strong>
        {!compact && <small>PRIVATE DEV WORKSPACE</small>}
      </div>
    </div>
  );
}

function Login({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken);
      onSuccess(data.user);
    }
  });
  return (
    <main className="login-page">
      <div className="login-glow" />
      <section className="login-card">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow"><ShieldCheck size={14} /> Acceso privado</span>
          <h1>Tu entorno de desarrollo, en cualquier lugar.</h1>
          <p>Conecta de forma segura con tus proyectos y servidores.</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
          <label>Correo electrónico<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" required /></label>
          <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" minLength={12} required /></label>
          {mutation.error && <p className="form-error" role="alert">{mutation.error.message}</p>}
          <button className="primary-button" disabled={mutation.isPending}>
            {mutation.isPending ? "Verificando…" : "Entrar a JuanOS"} <ArrowUpRight size={17} />
          </button>
        </form>
        <div className="secure-note"><span><i /> Conexión cifrada</span><span>Sesión protegida</span></div>
      </section>
      <footer>JuanOS · Acceso personal autorizado únicamente</footer>
    </main>
  );
}

/** @type {Array<[string, import("react").ComponentType<any>]>} */
const navItems = [
  ["Inicio", Server], ["Proyectos", FolderGit2], ["Actividad", Activity],
  ["Terminal", TerminalSquare], ["Ajustes", Settings]
];

function Sidebar({ active, setActive, onLogout, projectCount }) {
  return (
    <aside className="sidebar">
      <Brand productOnly />
      <nav>
        <span className="nav-label">Workspace</span>
        {navItems.map(([label, Icon]) => (
          <button key={label} className={active === label ? "active" : ""} onClick={() => setActive(label)}>
            <Icon size={19} /><span>{label}</span>{label === "Proyectos" && <b>{projectCount}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="server-health"><i /><div><strong>VPS conectado</strong><small>Estado observado por el worker</small></div><Wifi size={16} /></div>
        <img className="sidebar-signature" src="/brand/juan-cruz-logo-dark.svg" alt="Juan Cruz — Consultor senior tecnólogo" />
        <button className="user-chip" onClick={onLogout}><span>JC</span><div><strong>Juan Cruz</strong><small>Administrador</small></div><LogOut size={16} /></button>
      </div>
    </aside>
  );
}

function ProjectCard({ project, onOpen, onDetail, onRemove, removing }) {
  const clean = project.repositoryStatus === "clean";
  const repositoryAvailable = project.repositoryStatus !== "unavailable";
  const serviceLabel = project.service === "attention" ? "Revisar" : project.service === "online" ? "En línea" : project.service === "offline" ? "Offline" : "Sin comprobar";
  return (
    <article className={`project-card ${project.isJuanOS ? "is-juanos" : ""}`}>
      {project.isJuanOS && <div className="self-badge"><ShieldCheck size={12} /> ESTA APLICACIÓN</div>}
      <header>
        <div className="project-icon"><Braces size={21} /></div>
        <div className="project-title"><h3>{project.name}</h3><span><i className={project.service === "online" ? "" : "off"} /> {serviceLabel}</span></div>
        {project.isJuanOS
          ? <span className="icon-button passive" title="JuanOS no se puede quitar"><ShieldCheck size={18} /></span>
          : <button className="icon-button danger" disabled={removing} aria-label={`Quitar ${project.name} de JuanOS`} title="Quitar del catálogo" onClick={() => onRemove(project)}><Trash2 size={18} /></button>}
      </header>
      <div className="repo-line"><FolderGit2 size={14} /><span>{(project.repositoryUrl || "Repositorio no registrado").replace("https://", "")}</span></div>
      <div className="stats">
        <div><small>Rama</small><strong><GitBranch size={14} /> {project.currentBranch || project.defaultBranch}</strong></div>
        <div><small>Estado</small><strong className={clean ? "clean" : "modified"}><CircleDot size={14} /> {!repositoryAvailable ? "No disponible" : clean ? "Limpio" : `${project.changedFiles || 0} cambios`}</strong></div>
      </div>
      <div className="platform-facts">
        <span>{project.applicationType || "other"}</span><span>{project.strategy || "sin estrategia"}</span>
        <span>{project.pendingCommits === null ? "remoto no verificado" : `${project.pendingCommits} commits pendientes`}</span>
        {project.domain && <span>SSL · {project.sslDaysRemaining ?? "?"} días</span>}
      </div>
      <div className="commit">
        <div className="commit-mark"><Code2 size={15} /></div>
        <div><small>Último commit · {project.commit || "—"}</small><strong>{project.message || "Repositorio preparado"}</strong></div>
        <span>{relativeTime(project.committedAt)}</span>
      </div>
      <div className="project-actions">
        <button onClick={() => onDetail(project.id, "terminal")}><TerminalSquare size={16} /> Terminal</button>
        <button onClick={() => onDetail(project.id, "logs")}><Activity size={16} /> Logs</button>
        <button onClick={() => onOpen("Actividad")}><RefreshCw size={15} /> Actualizar</button>
        <button className="deploy" onClick={() => onDetail(project.id, "summary")}><ChevronRight size={16} /> Detalle</button>
      </div>
    </article>
  );
}

function NewProjectModal({ onClose }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: "", slug: "", localPath: "/srv/juanos/projects/", repositoryUrl: "https://github.com/",
    defaultBranch: "main", installCommand: "", buildCommand: "", deployCommand: "",
    deploymentType: "systemd", serviceName: "", applicationType: "other",
    strategy: "systemd", isJuanOS: false, workingDirectory: ".", buildOutputDir: "dist",
    composeFile: "compose.yml", dockerfile: "Dockerfile", port: "", domain: "",
    healthUrl: "", activateSsl: false
  });
  const create = useMutation({
    mutationFn: () => api("/projects", {
      method: "POST",
      body: JSON.stringify({
        ...form,
        port: undefined,
        workingDirectory: undefined,
        buildOutputDir: undefined,
        composeFile: undefined,
        dockerfile: undefined,
        healthUrl: undefined,
        activateSsl: undefined,
        domain: form.domain || undefined,
        strategyConfig: {
          workingDirectory: form.workingDirectory,
          buildOutputDir: form.buildOutputDir,
          composeFile: form.strategy === "docker_compose" ? form.composeFile : undefined,
          dockerfile: form.strategy === "docker" ? form.dockerfile : undefined,
          port: form.port ? Number(form.port) : undefined,
          hasBuild: form.applicationType !== "other",
          serviceName: form.serviceName,
          processName: form.strategy === "pm2" ? form.serviceName : undefined,
          nginx: { enabled: form.strategy === "static_nginx" || Boolean(form.domain) },
          ssl: form.domain ? { activate: form.activateSsl, domain: form.domain, includeWww: false } : undefined
        },
        healthCheck: form.healthUrl ? {
          url: form.healthUrl, expectedStatus: 200, timeoutMs: 5000, retries: 3
        } : undefined
      })
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["projects"] }); onClose(); }
  });
  const update = (key, value) => setForm((current) => {
    const next = { ...current, [key]: value };
    if (key === "slug" && (!current.localPath || current.localPath.startsWith("/srv/juanos/projects/"))) {
      next.localPath = `/srv/juanos/projects/${value}`;
    }
    return next;
  });
  const steps = ["Repositorio", "Análisis", "Configuración", "Dominio / salud", "Plan"];
  const canContinue = step === 0
    ? form.name.length >= 2 && form.slug.length >= 2 && form.repositoryUrl.startsWith("http")
    : step === 1 ? Boolean(form.applicationType && form.strategy && form.serviceName)
      : step === 2 ? Boolean(form.localPath && form.workingDirectory) : true;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <section className="project-modal wizard-modal" role="dialog" aria-modal="true" aria-label="Nuevo proyecto">
      <div className="modal-head"><div><span className="eyebrow">Paso {step + 1} de {steps.length}</span><h2>{steps[step]}</h2></div><button onClick={onClose}>×</button></div>
      <div className="wizard-progress">{steps.map((label, index) => <span className={index <= step ? "active" : ""} key={label}><i />{label}</span>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        {step === 0 && <><label>Repositorio Git<input type="url" value={form.repositoryUrl} onChange={(e) => update("repositoryUrl", e.target.value)} required /></label><div className="form-grid"><label>Nombre<input value={form.name} onChange={(e) => update("name", e.target.value)} required /></label><label>Slug<input value={form.slug} onChange={(e) => update("slug", e.target.value)} pattern="[a-z0-9-]+" required /></label></div><label>Rama principal<input value={form.defaultBranch} onChange={(e) => update("defaultBranch", e.target.value)} required /></label></>}
        {step === 1 && <><p className="wizard-note"><Search size={15} /> El repositorio se clonará y se verificará dentro del plan. Confirma ahora la clasificación; JuanOS nunca adivina una estrategia ambigua.</p><div className="form-grid">
          <label>Tipo de aplicación<select value={form.applicationType} onChange={(e) => update("applicationType", e.target.value)}><option value="frontend">Frontend</option><option value="backend">Backend</option><option value="fullstack">Fullstack</option><option value="django">Django</option><option value="other">Otro</option></select></label>
          <label>Estrategia<select value={form.strategy} onChange={(e) => { update("strategy", e.target.value); update("deploymentType", e.target.value.startsWith("docker") ? "docker-compose" : "systemd"); }}><option value="static_nginx">Static + Nginx</option><option value="pm2">PM2</option><option value="systemd">systemd</option><option value="docker">Docker</option><option value="docker_compose">Docker Compose</option></select></label>
        </div><label>Servicio principal<input value={form.serviceName} onChange={(e) => update("serviceName", e.target.value)} placeholder="api" required /></label></>}
        {step === 2 && <><label>Ruta autorizada<input value={form.localPath} onChange={(e) => update("localPath", e.target.value)} required /></label><div className="form-grid"><label>Directorio de trabajo<input value={form.workingDirectory} onChange={(e) => update("workingDirectory", e.target.value)} required /></label><label>Puerto interno (opcional)<input inputMode="numeric" value={form.port} onChange={(e) => update("port", e.target.value)} /></label></div>{form.strategy === "static_nginx" && <label>Salida del build<input value={form.buildOutputDir} onChange={(e) => update("buildOutputDir", e.target.value)} /></label>}{form.strategy === "docker_compose" && <label>Compose file<input value={form.composeFile} onChange={(e) => update("composeFile", e.target.value)} /></label>}{form.strategy === "docker" && <label>Dockerfile<input value={form.dockerfile} onChange={(e) => update("dockerfile", e.target.value)} /></label>}</>}
        {step === 3 && <><label>Dominio (opcional)<input value={form.domain} onChange={(e) => update("domain", e.target.value)} placeholder="app.ejemplo.com" /></label><label>Health check HTTP (opcional)<input type="url" value={form.healthUrl} onChange={(e) => update("healthUrl", e.target.value)} placeholder="https://app.ejemplo.com/health" /></label>{form.domain && <label className="check-label"><input type="checkbox" checked={form.activateSsl} onChange={(e) => update("activateSsl", e.target.checked)} /> Activar SSL en el despliegue (puede dejarse para después)</label>}<label className="check-label"><input type="checkbox" checked={form.isJuanOS} onChange={(e) => update("isJuanOS", e.target.checked)} /> Esta aplicación es JuanOS y debe protegerse</label></>}
        {step === 4 && <div className="wizard-plan"><p><strong>Repositorio</strong><span>{form.repositoryUrl} · {form.defaultBranch}</span></p><p><strong>Aplicación</strong><span>{form.applicationType} · {form.strategy}</span></p><p><strong>Destino</strong><span>{form.localPath}</span></p><p><strong>Servicio</strong><span>{form.serviceName}{form.port ? ` · puerto ${form.port}` : ""}</span></p><p><strong>Dominio</strong><span>{form.domain || "Sin dominio"}{form.activateSsl ? " · activar SSL" : ""}</span></p><p className="wizard-note"><ShieldCheck size={15} /> Registrar no ejecuta nada. Después JuanOS generará un plan inmutable para clonar, construir, publicar y comprobar salud.</p></div>}
        {create.error && <p className="form-error">{create.error.message}</p>}
        <div className="modal-actions"><button type="button" onClick={() => step === 0 ? onClose() : setStep((current) => current - 1)}>{step === 0 ? "Cancelar" : "Atrás"}</button>{step < steps.length - 1 ? <button type="button" className="primary-button small" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>Continuar <ChevronRight size={15} /></button> : <button className="primary-button small" disabled={create.isPending}>{create.isPending ? "Registrando…" : "Registrar y continuar"}</button>}</div>
      </form>
    </section>
  </div>;
}

function ImportProjectModal({ onClose }) {
  const queryClient = useQueryClient();
  const discovery = useQuery({ queryKey: ["project-discovery"], queryFn: () => api("/projects/discovery") });
  const [selectedPath, setSelectedPath] = useState("");
  const [overrides, setOverrides] = useState({ slug: "", repositoryUrl: "", strategy: "", isJuanOS: false });
  const candidates = discovery.data?.candidates || [];
  const selected = candidates.find((candidate) => candidate.projectPath === selectedPath);
  const choose = (candidate) => {
    setSelectedPath(candidate.projectPath);
    setOverrides({
      slug: candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      repositoryUrl: candidate.repositoryUrl || "",
      strategy: candidate.strategy.strategy || candidate.strategy.candidates[0] || "",
      isJuanOS: candidate.name.toLowerCase() === "juanos"
    });
  };
  const importProject = useMutation({
    mutationFn: () => api("/projects/import", {
      method: "POST",
      body: JSON.stringify({
        projectPath: selected.projectPath,
        name: selected.name,
        slug: overrides.slug,
        repositoryUrl: overrides.repositoryUrl || undefined,
        applicationType: selected.applicationType,
        strategy: overrides.strategy || undefined,
        confirmAmbiguous: selected.confidence === "ambiguous" || selected.strategy.ambiguous,
        isJuanOS: overrides.isJuanOS
      })
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project-discovery"] });
      onClose();
    }
  });
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="project-modal import-modal" role="dialog" aria-modal="true" aria-label="Importar aplicaciones">
      <div className="modal-head"><div><span className="eyebrow">Inspección del servidor</span><h2>Importar aplicación</h2></div><button onClick={onClose}>×</button></div>
      {discovery.isPending && <p className="muted-copy">Analizando rutas autorizadas…</p>}
      {discovery.error && <p className="form-error">{discovery.error.message}</p>}
      {!selected && <div className="candidate-list">{candidates.map((candidate) => <button key={candidate.projectPath} disabled={candidate.registered} onClick={() => choose(candidate)}>
        <strong>{candidate.name}</strong><span>{candidate.applicationType} · {candidate.confidence}</span><small>{candidate.projectPath}</small>{candidate.registered && <b>Ya registrada</b>}
      </button>)}</div>}
      {selected && <div className="import-review">
        <button className="back-link" onClick={() => setSelectedPath("")}>← Volver</button>
        <div className={`confidence ${selected.confidence}`}><CircleDot size={13} /> Detección {selected.confidence}</div>
        <h3>{selected.name}</h3>
        <div className="evidence-list">{selected.evidence.map((item, index) => <div key={`${item.source}-${index}`}><strong>{item.source}</strong><span>{item.detail}</span></div>)}</div>
        {selected.strategy.ambiguous && <p className="warning-box"><AlertTriangle size={15} /> Se detectaron varias estrategias. Confirma cuál representa producción.</p>}
        <form onSubmit={(event) => { event.preventDefault(); importProject.mutate(); }}>
          <label>Slug<input value={overrides.slug} onChange={(event) => setOverrides((current) => ({ ...current, slug: event.target.value }))} required /></label>
          <label>Repositorio<input value={overrides.repositoryUrl} onChange={(event) => setOverrides((current) => ({ ...current, repositoryUrl: event.target.value }))} required /></label>
          <label>Estrategia<select value={overrides.strategy} onChange={(event) => setOverrides((current) => ({ ...current, strategy: event.target.value }))} required><option value="">Selecciona…</option><option value="static_nginx">Static + Nginx</option><option value="pm2">PM2</option><option value="systemd">systemd</option><option value="docker">Docker</option><option value="docker_compose">Docker Compose</option></select></label>
          <label className="check-label"><input type="checkbox" checked={overrides.isJuanOS} onChange={(event) => setOverrides((current) => ({ ...current, isJuanOS: event.target.checked }))} /> Marcar como ESTA APLICACIÓN</label>
          {importProject.error && <p className="form-error">{importProject.error.message}</p>}
          <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button className="primary-button small" disabled={importProject.isPending}>{importProject.isPending ? "Importando…" : "Confirmar importación"}</button></div>
        </form>
      </div>}
    </section>
  </div>;
}

const mobileKeys = [
  ["Tab", "\t"], ["Esc", "\u001b"], ["Ctrl+C", "\u0003"], ["Ctrl+D", "\u0004"],
  ["↑", "\u001b[A"], ["↓", "\u001b[B"], ["←", "\u001b[D"], ["→", "\u001b[C"],
  ["/", "/"], ["-", "-"], ["_", "_"], ["|", "|"], ["~", "~"]
];

function TerminalView({ projects, initialProjectId = "" }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const socketRef = useRef(null);
  const sessionIdRef = useRef("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectId = selectedProjectId || initialProjectId || projects[0]?.id || "";
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    if (!containerRef.current || !projectId || projectId.startsWith("preview")) return undefined;
    const terminalContainer = containerRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#0B0D10",
        foreground: "#F8F4EE",
        cursor: "#D4A06A",
        cursorAccent: "#0B0D10",
        selectionBackground: "#B68C5A55",
        black: "#0B0D10",
        brightBlack: "#586273",
        white: "#F5F2EA",
        brightWhite: "#F8F4EE",
        yellow: "#D4A06A",
        brightYellow: "#D9C2A3",
        green: "#72B89B",
        brightGreen: "#8FC9AE"
      },
      scrollback: 5000
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalContainer);
    terminal.focus();
    terminalRef.current = terminal;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;
    let attempts = 0;
    let reconnectTimer;
    let fitFrame;
    const fitTerminal = () => {
      window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        terminal.scrollToBottom();
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      });
    };
    fitTerminal();
    document.fonts?.ready.then(fitTerminal).catch(() => {});
    const connect = () => {
      const resume = sessionIdRef.current ? `&sessionId=${encodeURIComponent(sessionIdRef.current)}` : "";
      const socket = new WebSocket(`${protocol}//${location.host}/ws/terminal?projectId=${encodeURIComponent(projectId)}${resume}`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        attempts = 0;
        setStatus("online");
        terminal.focus();
        fitTerminal();
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        setStatus(event.code === 1000 ? "connecting" : "offline");
        attempts += 1;
        if (attempts === 1 && event.code !== 1000) {
          terminal.writeln(`\r\n\x1b[31m[JuanOS] Terminal no disponible (${event.reason || "conexión cerrada"}). Reintentando…\x1b[0m`);
        }
        reconnectTimer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** attempts));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          if (message.resumed) terminal.reset();
          sessionIdRef.current = message.terminalSessionId;
        }
        if (message.type === "output") terminal.write(message.data);
      });
    };
    connect();
    terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    const resize = new ResizeObserver(fitTerminal);
    resize.observe(terminalContainer);
    window.visualViewport?.addEventListener("resize", fitTerminal);
    window.addEventListener("orientationchange", fitTerminal);
    const pasteHandler = (event) => {
      const text = event.clipboardData?.getData("text") || "";
      if (text.includes("\n") && !window.confirm(`Vas a pegar ${text.split("\n").length} líneas en la terminal. ¿Continuar?`)) event.preventDefault();
    };
    const focusHandler = () => terminal.focus();
    terminalContainer.addEventListener("paste", pasteHandler);
    terminalContainer.addEventListener("pointerdown", focusHandler);
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.cancelAnimationFrame(fitFrame);
      resize.disconnect();
      window.visualViewport?.removeEventListener("resize", fitTerminal);
      window.removeEventListener("orientationchange", fitTerminal);
      terminalContainer.removeEventListener("paste", pasteHandler);
      terminalContainer.removeEventListener("pointerdown", focusHandler);
      socketRef.current?.close();
      terminal.dispose();
      sessionIdRef.current = "";
    };
  }, [projectId]);
  const send = (data) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data }));
  };
  return (
    <section className="terminal-screen">
      <div className="terminal-toolbar">
        <div><span className={`terminal-dot ${status}`} /><strong>Terminal</strong></div>
        <select value={projectId} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <button onClick={() => send("\u0003")}>Ctrl+C</button>
        <button onClick={() => terminalRef.current?.clear()}>Limpiar</button>
      </div>
      {projectId.startsWith("preview") && <div className="terminal-empty"><TerminalSquare size={32} /><strong>Conecta la base de datos</strong><span>La terminal real se habilita al cargar un proyecto registrado.</span></div>}
      <div className="terminal-host" ref={containerRef} />
      <div className="mobile-keys">{mobileKeys.map(([label, value]) => <button key={label} onClick={() => send(value)}>{label}</button>)}</div>
    </section>
  );
}

function flattenTree(nodes, depth = 0) {
  return nodes.flatMap((node) => [
    { ...node, depth },
    ...(node.children ? flattenTree(node.children, depth + 1) : [])
  ]);
}

function FilesView({ projects, initialProjectId = "" }) {
  const queryClient = useQueryClient();
  const realProjects = projects.filter((project) => !project.id.startsWith("preview"));
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectId = selectedProjectId || initialProjectId || realProjects[0]?.id || "";
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [hash, setHash] = useState("");
  const [drawer, setDrawer] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const treeQuery = useQuery({
    queryKey: ["files", projectId],
    queryFn: () => api(`/projects/${projectId}/files/tree`),
    enabled: Boolean(projectId)
  });
  const gitQuery = useQuery({
    queryKey: ["git", projectId],
    queryFn: () => api(`/projects/${projectId}/git/status`),
    enabled: Boolean(projectId)
  });
  const save = useMutation({
    mutationFn: () => api(`/projects/${projectId}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path: selectedPath, content, expectedHash: hash })
    }),
    onSuccess: (data) => {
      setHash(data.hash);
      queryClient.invalidateQueries({ queryKey: ["git", projectId] });
    }
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["files", projectId] });
    queryClient.invalidateQueries({ queryKey: ["git", projectId] });
  };
  const entryMutation = useMutation({
    mutationFn: (/** @type {{method: string, body: any}} */ payload) => api(`/projects/${projectId}/files/entry`, { method: payload.method, body: JSON.stringify(payload.body) }),
    onSuccess: refresh
  });
  const createEntry = (type) => {
    const target = window.prompt(type === "directory" ? "Ruta de la nueva carpeta" : "Ruta del nuevo archivo");
    if (target) entryMutation.mutate({ method: "POST", body: { path: target, type } });
  };
  const renameEntry = () => {
    if (!selectedPath) return;
    const target = window.prompt("Nueva ruta", selectedPath);
    if (target && target !== selectedPath) entryMutation.mutate({ method: "PATCH", body: { path: selectedPath, newPath: target } }, { onSuccess: () => setSelectedPath(target) });
  };
  const deleteEntry = () => {
    if (!selectedPath || !window.confirm(`Eliminar definitivamente ${selectedPath}?`)) return;
    entryMutation.mutate({ method: "DELETE", body: { path: selectedPath, confirm: true } }, {
      onSuccess: () => { setSelectedPath(""); setContent(""); setHash(""); }
    });
  };
  const searchProject = async (event) => {
    event.preventDefault();
    if (searchText.trim().length < 2) return;
    const data = await api(`/projects/${projectId}/files/search?q=${encodeURIComponent(searchText.trim())}`);
    setSearchResults(data.matches);
  };
  const openFile = async (path) => {
    const data = await api(`/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`);
    setSelectedPath(path);
    setContent(data.content);
    setHash(data.hash);
    setDrawer(false);
  };
  if (!projectId) return <div className="feature-empty"><FileCode2 size={32} /><strong>Editor preparado</strong><span>Registra un proyecto real para explorar y editar archivos de forma segura.</span></div>;
  return (
    <section className="files-screen">
      <div className={`file-tree ${drawer ? "open" : ""}`}>
        <div className="file-tree-head"><strong>Explorador</strong><select value={projectId} onChange={(e) => setSelectedProjectId(e.target.value)}>{realProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><div className="file-actions"><button title="Nuevo archivo" onClick={() => createEntry("file")}><FilePlus2 size={14} /></button><button title="Nueva carpeta" onClick={() => createEntry("directory")}><FolderPlus size={14} /></button><button title="Renombrar" disabled={!selectedPath} onClick={renameEntry}><Pencil size={13} /></button><button title="Eliminar" disabled={!selectedPath} onClick={deleteEntry}><Trash2 size={13} /></button></div><form className="file-search" onSubmit={searchProject}><Search size={13} /><input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Buscar texto…" /></form></div>
        {searchResults.length > 0 && <div className="search-results">{searchResults.map((match) => <button key={`${match.path}:${match.line}`} onClick={() => openFile(match.path)}><strong>{match.path}:{match.line}</strong><span>{match.preview}</span></button>)}</div>}
        <div className="tree-list">{flattenTree(treeQuery.data?.tree || []).map((node) => <button key={node.path} className={selectedPath === node.path ? "selected" : ""} style={{ paddingLeft: 12 + node.depth * 14 }} onClick={() => node.type === "file" ? openFile(node.path) : setSelectedPath(node.path)}>{node.type === "directory" ? "▾" : "·"} {node.name}</button>)}</div>
      </div>
      <div className="editor-pane">
        <div className="editor-toolbar"><button className="drawer-toggle" onClick={() => setDrawer(!drawer)}>☰</button><code>{selectedPath || "Selecciona un archivo"}</code><span className={save.isSuccess ? "saved" : ""}>{save.isPending ? "Guardando…" : save.isSuccess ? "Guardado" : ""}</span><button disabled={!selectedPath || save.isPending} onClick={() => save.mutate()}>Guardar</button></div>
        {selectedPath ? <Suspense fallback={<div className="editor-loading">Cargando editor…</div>}><MonacoEditor value={content} onChange={(value) => setContent(value || "")} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", padding: { top: 14 }, automaticLayout: true }} path={selectedPath} /></Suspense> : <div className="editor-loading">Elige un archivo de texto en el explorador.</div>}
        <details className="git-mobile"><summary>Git · {(gitQuery.data?.files || []).length} cambios</summary><GitControls projectId={projectId} gitQuery={gitQuery} onRefresh={refresh} /></details>
      </div>
      <aside className="diff-pane"><GitControls projectId={projectId} gitQuery={gitQuery} onRefresh={refresh} /></aside>
    </section>
  );
}

function GitControls({ projectId, gitQuery, onRefresh }) {
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const action = useMutation({
    mutationFn: (/** @type {Record<string, any>} */ body) => api(`/projects/${projectId}/git/action`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { setMessage(""); onRefresh(); }
  });
  const paths = (gitQuery.data?.files || []).map((file) => file.path);
  const stagedPaths = (gitQuery.data?.files || []).filter((file) => ![" ", "?"].includes(file.index)).map((file) => file.path);
  return <div className="git-controls">
    <div className="git-heading"><strong>Cambios Git</strong><button onClick={onRefresh}><RefreshCw size={13} /></button></div>
    <div className="git-remote-actions"><button disabled={action.isPending} onClick={() => action.mutate({ action: "fetch" })}>Fetch</button><button disabled={action.isPending} onClick={() => action.mutate({ action: "pull" })}>Pull</button><button disabled={action.isPending} onClick={() => action.mutate({ action: "push" })}><UploadCloud size={12} /> Push</button></div>
    <div className="git-files">{(gitQuery.data?.files || []).map((file) => <div key={file.path}><code>{file.index}{file.worktree}</code><span>{file.path}</span></div>)}</div>
    <div className="staging-actions"><button className="stage-button" disabled={!paths.length || action.isPending} onClick={() => action.mutate({ action: "stage", paths })}>Añadir todos</button><button className="stage-button" disabled={!stagedPaths.length || action.isPending} onClick={() => action.mutate({ action: "unstage", paths: stagedPaths })}>Quitar staging</button></div>
    <div className="commit-box"><input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Mensaje del commit" /><button disabled={!message.trim() || action.isPending} onClick={() => action.mutate({ action: "commit", message })}><GitCommitHorizontal size={13} /> Commit</button></div>
    <div className="branch-box"><input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="nombre-rama" /><button disabled={!branch || action.isPending} onClick={() => action.mutate({ action: "create-branch", branch })}>Crear</button><button disabled={!branch || action.isPending} onClick={() => action.mutate({ action: "switch-branch", branch })}>Cambiar</button></div>
    {action.error && <p className="form-error">{action.error.message}</p>}
    <pre>{gitQuery.data?.diff || "No hay cambios sin guardar."}</pre>
  </div>;
}

function DeploymentsView({ projects, initialProjectId = "", initialOperation = "update" }) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectId = selectedProjectId || initialProjectId || projects[0]?.id || "";
  const validInitialOperation = ["deploy", "update", "repair", "restart", "ssl_test", "recovery", "recovery_test", "rollback"].includes(initialOperation)
    ? initialOperation
    : "update";
  const [operation, setOperation] = useState(validInitialOperation);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [liveLog, setLiveLog] = useState("");
  const deployments = useQuery({
    queryKey: ["deployments", projectId],
    queryFn: () => api(`/deployments?applicationId=${encodeURIComponent(projectId)}`),
    enabled: Boolean(projectId)
  });
  const connectToDeployment = (deploymentId) => {
      setLiveLog("Operación en cola; puedes cerrar esta pantalla sin detenerla.\n");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws/deployments?id=${deploymentId}`);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "output") setLiveLog((value) => value + message.data);
        if (message.type === "end") {
          socket.close();
          queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
        }
      };
  };
  const createPlan = useMutation({
    mutationFn: () => api("/deployments/plans", {
      method: "POST",
      body: JSON.stringify({ applicationId: projectId, operation })
    }),
    onSuccess: (result) => setPendingPlan(result)
  });
  const confirmPlan = useMutation({
    mutationFn: () => api(`/deployments/${pendingPlan.deploymentId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ planHash: pendingPlan.planHash })
    }),
    onSuccess: ({ deploymentId }) => {
      setPendingPlan(null);
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
      window.setTimeout(() => connectToDeployment(deploymentId), 350);
    }
  });
  const cancelPlan = useMutation({
    mutationFn: () => api(`/deployments/${pendingPlan.deploymentId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      setPendingPlan(null);
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
    }
  });
  return (
    <section className="deploy-screen">
      <div className="deploy-head"><div><span className="eyebrow">Plan → confirmación → worker</span><h1>Despliegues</h1></div><div className="deploy-controls"><select value={projectId} onChange={(e) => { setSelectedProjectId(e.target.value); setPendingPlan(null); setLiveLog(""); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.isJuanOS ? "JuanOS · ESTA APLICACIÓN" : project.name}</option>)}</select><select value={operation} onChange={(event) => setOperation(event.target.value)}><option value="update">Actualizar</option><option value="deploy">Desplegar</option><option value="restart">Reiniciar</option><option value="repair">Reparar</option><option value="rollback">Rollback release</option><option value="ssl_test">Probar SSL</option><option value="recovery">Crear recovery</option><option value="recovery_test">Probar recovery</option></select><button className="primary-button small" disabled={!projectId || createPlan.isPending} onClick={() => createPlan.mutate()}><Rocket size={16} /> Generar plan</button></div></div>
      {createPlan.error && <div className="form-error">{createPlan.error.message}</div>}
      {pendingPlan && <section className="plan-review">
        <header><div><span className="eyebrow">Plan inmutable</span><h2>Revisa antes de ejecutar</h2></div><code>{pendingPlan.planHash.slice(0, 12)}</code></header>
        <section className="plan-version" aria-label="Versión revisada del despliegue">
          <h3>Versión incluida en este plan</h3>
          <dl>
            <div><dt>Rama destino</dt><dd><code>{pendingPlan.plan.targetBranch || "No informada"}</code></dd></div>
            <div><dt>Commit destino fijado</dt><dd><code title={pendingPlan.plan.targetCommitSha || undefined}>{pendingPlan.plan.targetCommitSha || "No fijado para esta operación"}</code></dd></div>
            <div><dt>Versión de origen</dt><dd>{pendingPlan.plan.sourceBranch || "Sin rama local"} · <code title={pendingPlan.plan.sourceCommitSha || undefined}>{pendingPlan.plan.sourceCommitSha?.slice(0, 12) || "Sin commit local"}</code></dd></div>
          </dl>
          {pendingPlan.plan.targetCommitSha && <p>La confirmación corresponde a este commit exacto, no a cambios posteriores de la rama.</p>}
        </section>
        {pendingPlan.plan.isJuanOS && <p className="self-warning"><ShieldCheck size={16} /> JuanOS creará recovery antes de preparar su actualización.</p>}
        {pendingPlan.plan.warnings.map((warning) => <p className="warning-box" key={warning.code}><AlertTriangle size={15} /> {warning.message}</p>)}
        <ol>{pendingPlan.plan.steps.map((step) => <li key={step.stepKey}><span>{pendingPlan.plan.steps.indexOf(step) + 1}</span><div><strong>{step.name}</strong><small>{step.action}{step.requiresSudo ? " · requiere privilegios limitados" : ""}</small></div></li>)}</ol>
        {(confirmPlan.error || cancelPlan.error) && <p className="form-error">{(confirmPlan.error || cancelPlan.error).message}</p>}
        <div className="plan-actions"><button disabled={cancelPlan.isPending || confirmPlan.isPending} onClick={() => cancelPlan.mutate()}>{cancelPlan.isPending ? "Cancelando…" : "Cancelar"}</button><button className="primary-button small" disabled={confirmPlan.isPending || cancelPlan.isPending} onClick={() => confirmPlan.mutate()}>{confirmPlan.isPending ? "Encolando…" : "Confirmar y ejecutar"}</button></div>
      </section>}
      {liveLog && <pre className="live-log">{liveLog}</pre>}
      <div className="deployment-list">{(deployments.data?.deployments || []).map((item) => <article key={item.id}><span className={`deployment-status ${item.status}`} /><div><strong>{item.projectName}</strong><small>{item.operation} · {item.branch} · {(item.commitSha || "").slice(0, 8)}</small></div><b>{item.status}</b><time>{new Date(item.startedAt).toLocaleString()}</time></article>)}</div>
    </section>
  );
}

function EnvironmentsView({ projects, initialProjectId = "" }) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectId = selectedProjectId || initialProjectId || projects[0]?.id || "";
  const [revealed, setRevealed] = useState({});
  const [editing, setEditing] = useState(null);
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api(`/projects/${projectId}/environments`),
    enabled: Boolean(projectId)
  });
  const scan = useMutation({
    mutationFn: () => api(`/projects/${projectId}/environments/scan`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["environments", projectId] })
  });
  const reveal = useMutation({
    mutationFn: (/** @type {{fileId: string, key: string}} */ input) => api(`/projects/${projectId}/environments/files/${input.fileId}/reveal`, {
      method: "POST", body: JSON.stringify({ key: input.key })
    }),
    onSuccess: (data, input) => setRevealed((current) => ({ ...current, [`${input.fileId}:${input.key}`]: data.value }))
  });
  const validate = useMutation({
    mutationFn: (/** @type {{fileId: string, fingerprint: string}} */ input) => api(`/projects/${projectId}/environments/files/${input.fileId}/validate`, {
      method: "POST", body: JSON.stringify({ fingerprint: input.fingerprint })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["environments", projectId] })
  });
  const update = useMutation({
    mutationFn: (/** @type {{fileId: string, key: string, value: string, fingerprint: string}} */ input) => api(`/projects/${projectId}/environments/files/${input.fileId}/variables`, {
      method: "PATCH", body: JSON.stringify({ key: input.key, value: input.value, expectedFingerprint: input.fingerprint })
    }),
    onSuccess: () => {
      setEditing(null);
      setRevealed({});
      queryClient.invalidateQueries({ queryKey: ["environments", projectId] });
    }
  });
  const files = (environments.data?.environments || []).flatMap((environment) =>
    environment.files.map((file) => ({ ...file, environmentName: environment.name }))
  );
  return <section className="environment-screen">
    <div className="deploy-head"><div><span className="eyebrow">Valores reales en disco</span><h1>Variables</h1></div><div><select value={projectId} onChange={(event) => { setSelectedProjectId(event.target.value); setRevealed({}); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button className="secondary-button" disabled={!projectId || scan.isPending} onClick={() => scan.mutate()}><RefreshCw size={15} /> {scan.isPending ? "Analizando…" : "Escanear .env"}</button></div></div>
    <p className="environment-note"><ShieldCheck size={15} /> PostgreSQL solo guarda metadata y fingerprints. Los valores permanecen en cada archivo.</p>
    {(scan.error || environments.error || reveal.error || validate.error || update.error) && <p className="form-error">{(scan.error || environments.error || reveal.error || validate.error || update.error).message}</p>}
    {!files.length && !environments.isPending && <div className="feature-empty compact-empty"><Braces size={27} /><strong>No hay archivos de entorno registrados</strong><span>Escanea la aplicación para detectar `.env` reales.</span></div>}
    <div className="environment-files">{files.map((file) => <article key={file.id}>
      <header><div><strong>{file.path}</strong><small>{file.environmentName} · fingerprint {file.contentFingerprint?.slice(0, 10)}</small></div><span className={`env-status ${file.status}`}>{file.status}</span></header>
      <div className="variable-list">{file.variables.map((variable) => {
        const revealKey = `${file.id}:${variable.key}`;
        const isRevealed = Object.hasOwn(revealed, revealKey);
        const isEditing = editing?.fileId === file.id && editing?.key === variable.key;
        return <div className="variable-row" key={variable.key}>
          <code>{variable.key}</code><span>=</span>
          {isEditing ? <input autoFocus value={editing.value} onChange={(event) => setEditing((current) => ({ ...current, value: event.target.value }))} /> : <strong>{isRevealed ? revealed[revealKey] : "••••••••••••"}</strong>}
          <small>{variable.lifecycle}{variable.isRequired ? " · requerida" : ""}</small>
          <div>{isEditing ? <><button onClick={() => setEditing(null)}>Cancelar</button><button onClick={() => update.mutate({ fileId: file.id, key: variable.key, value: editing.value, fingerprint: file.contentFingerprint })}>Guardar</button></> : <><button aria-label={isRevealed ? "Ocultar" : "Revelar"} onClick={() => isRevealed ? setRevealed((current) => { const next = { ...current }; delete next[revealKey]; return next; }) : reveal.mutate({ fileId: file.id, key: variable.key })}>{isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}</button><button disabled={!isRevealed} title={isRevealed ? "Editar variable" : "Revela antes de editar"} onClick={() => setEditing({ fileId: file.id, key: variable.key, value: revealed[revealKey] })}><Pencil size={13} /></button></>}</div>
        </div>;
      })}</div>
      <footer><span>{file.variables.length} variables · valores ocultos por defecto</span>{file.status !== "validated" && <button className="secondary-button" disabled={validate.isPending} onClick={() => validate.mutate({ fileId: file.id, fingerprint: file.contentFingerprint })}><ShieldCheck size={14} /> Confirmar parsing</button>}</footer>
    </article>)}</div>
  </section>;
}

function OperationalLogsPanel({ projectId }) {
  const queryClient = useQueryClient();
  const sources = useQuery({
    queryKey: ["log-sources", projectId],
    queryFn: () => api(`/projects/${projectId}/logs/sources`),
    enabled: Boolean(projectId),
    refetchInterval: 2000
  });
  const [source, setSource] = useState("");
  const [service, setService] = useState("");
  const [lines, setLines] = useState(100);
  const [session, setSession] = useState(null);
  const [output, setOutput] = useState("");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pendingRef = useRef("");
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const sourceOptions = sources.data?.sources || [];
  const authorization = sources.data?.authorization;
  const activeSource = source || sourceOptions[0]?.id || "";
  const selectedSource = sourceOptions.find((item) => item.id === activeSource);
  const activeService = service || selectedSource?.service || selectedSource?.services?.[0] || "";
  const authorizationRequired = Boolean(
    selectedSource?.requiresAuthorization && authorization?.status !== "authorized"
  );
  const authorize = useMutation({
    mutationFn: () => api(`/projects/${projectId}/logs/authorization`, {
      method: "POST",
      body: JSON.stringify({ confirm: true })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["log-sources", projectId] })
  });
  const start = useMutation({
    mutationFn: () => api(`/projects/${projectId}/logs/sessions`, {
      method: "POST",
      body: JSON.stringify({
        source: activeSource,
        service: activeService || undefined,
        lines,
        follow: true
      })
    }),
    onSuccess: (created) => {
      setOutput("");
      pendingRef.current = "";
      setSession(created);
    }
  });
  const cancel = useMutation({
    mutationFn: () => api(`/projects/${projectId}/logs/sessions/${session.id}/cancel`, { method: "POST" }),
    onSuccess: () => setSession(null)
  });
  useEffect(() => {
    if (!session?.id) return undefined;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    let disposed = false;
    let retry;
    const connect = () => {
      socket = new WebSocket(`${protocol}//${location.host}/ws/logs?id=${session.id}`);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "output") {
          if (pausedRef.current) pendingRef.current += message.data;
          else setOutput((current) => (current + pendingRef.current + message.data).slice(-2_000_000));
          if (!pausedRef.current) pendingRef.current = "";
        }
        if (message.type === "end") {
          disposed = true;
          if (message.error) {
            setOutput((current) => `${current}${current ? "\n" : ""}Error: ${message.error}\n`);
          }
          setSession((current) => current ? { ...current, status: message.status } : current);
          socket.close();
        }
      };
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [session?.id]);
  const filtered = query
    ? output.split("\n").filter((line) => line.toLowerCase().includes(query.toLowerCase())).join("\n")
    : output;
  const resume = () => {
    setOutput((current) => (current + pendingRef.current).slice(-2_000_000));
    pendingRef.current = "";
    setPaused(false);
  };
  const emptyMessage = session
    ? session.status === "running" || session.status === "queued"
      ? "Esperando salida de la fuente autorizada…"
      : `El stream terminó con estado ${session.status}.`
    : "Selecciona una fuente y abre el stream.";
  const streamActive = Boolean(session && !["finished", "failed", "cancelled"].includes(session.status));
  return <section className="operational-logs">
    {authorizationRequired && <div className="warning-box observability-authorization">
      <AlertTriangle size={16} />
      <div>
        <strong>Observabilidad pendiente de autorización</strong>
        <span>
          {authorization?.status === "failed"
            ? authorization.error || "La autorización falló."
            : authorization?.status === "queued" || authorization?.status === "running"
              ? "El worker está aplicando una política limitada de estado y logs."
              : "Confirma el servicio detectado para permitir únicamente estado y logs desde JuanOS."}
        </span>
        <code>{activeService || authorization?.config?.composeFile || activeSource}</code>
      </div>
      <button
        className="secondary-button"
        disabled={authorize.isPending || ["queued", "running"].includes(authorization?.status)}
        onClick={() => authorize.mutate()}
      >
        {["queued", "running"].includes(authorization?.status) ? "Autorizando…" : "Autorizar observabilidad"}
      </button>
    </div>}
    <div className="log-toolbar">
      <select value={activeSource} onChange={(event) => {
        const next = sources.data?.sources?.find((item) => item.id === event.target.value);
        setSource(event.target.value);
        setService(next?.service || next?.services?.[0] || "");
      }}>{(sources.data?.sources || []).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
      {(selectedSource?.services?.length || selectedSource?.service) && <select value={activeService} onChange={(event) => setService(event.target.value)}>{(selectedSource.services || [selectedSource.service]).filter(Boolean).map((name) => <option value={name} key={name}>{name}</option>)}</select>}
      <select value={lines} onChange={(event) => setLines(Number(event.target.value))}><option value={100}>100 líneas</option><option value={500}>500 líneas</option><option value={1000}>1000 líneas</option></select>
      <button className="primary-button small" disabled={!activeSource || start.isPending || authorizationRequired || streamActive} onClick={() => start.mutate()}><Play size={14} /> {streamActive ? "Stream abierto" : "Abrir stream"}</button>
    </div>
    <div className="log-tools">
      <label><Search size={14} /><input placeholder="Buscar en logs" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button onClick={() => paused ? resume() : setPaused(true)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? " Reanudar" : " Pausar"}</button>
      <button onClick={() => navigator.clipboard.writeText(filtered)}><Copy size={14} /> Copiar</button>
      {streamActive && <button onClick={() => cancel.mutate()}><X size={14} /> Cerrar</button>}
    </div>
    {(sources.error || authorize.error || start.error || cancel.error) && <p className="form-error">{(sources.error || authorize.error || start.error || cancel.error).message}</p>}
    <pre className="live-log operational-output">{filtered || (sources.isPending ? "Buscando fuentes permitidas…" : emptyMessage)}</pre>
  </section>;
}

function ApplicationDetail({ projectId, projects, initialTab, initialOperation, onBack, onTabChange }) {
  const queryClient = useQueryClient();
  const tab = initialTab || "summary";
  const detail = useQuery({
    queryKey: ["application", projectId],
    queryFn: () => api(`/projects/${projectId}`)
  });
  const acceptObserved = useMutation({
    mutationFn: () => api(`/projects/${projectId}/state/accept-observed`, {
      method: "POST", body: JSON.stringify({ confirm: true })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["application", projectId] })
  });
  const ignoreObserved = useMutation({
    mutationFn: () => api(`/projects/${projectId}/state/ignore`, {
      method: "POST", body: JSON.stringify({ minutes: 60 })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["application", projectId] })
  });
  const application = detail.data?.application;
  if (detail.isPending) return <div className="feature-empty compact-empty">Cargando aplicación…</div>;
  if (detail.error || !application) return <div className="form-error">{detail.error?.message || "Aplicación no disponible"}</div>;
  const tabs = [
    ["summary", "Resumen"], ["deployments", "Deploys"], ["logs", "Logs"],
    ["variables", "Variables"], ["services", "Servicios"], ["config", "Configuración"],
    ["terminal", "Terminal"], ["files", "Archivos"]
  ];
  return <section className="application-detail">
    <header className="application-detail-head">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Aplicaciones</button>
      <div><span className="eyebrow">{application.applicationType} · {application.strategy}</span><h1>{application.name}</h1></div>
      {application.isJuanOS && <span className="self-badge"><ShieldCheck size={12} /> ESTA APLICACIÓN</span>}
    </header>
    <nav className="detail-tabs">{tabs.map(([id, label]) => <button className={tab === id ? "active" : ""} key={id} onClick={() => onTabChange(id)}>{label}</button>)}</nav>
    {tab === "summary" && <div className="detail-summary">
      <article><h3>Estado</h3><dl><div><dt>Proceso</dt><dd>{application.processStatus || "no comprobado"}</dd></div><div><dt>HTTP</dt><dd>{application.httpHealthStatus || "no comprobado"}</dd></div><div><dt>Funcional</dt><dd>{application.functionalHealthStatus || "no comprobado"}</dd></div><div><dt>Último deploy</dt><dd>{application.lastDeploymentStatus || "sin despliegues"}</dd></div></dl></article>
      <article><h3>Commits</h3><dl><div><dt>Repositorio</dt><dd><code>{application.repositoryCommitSha?.slice(0, 12) || "—"}</code></dd></div><div><dt>Desplegado</dt><dd><code>{application.deployedCommitSha?.slice(0, 12) || "no registrado"}</code></dd></div><div><dt>Remoto</dt><dd><code>{application.lastRemoteCommitSha?.slice(0, 12) || "no inspeccionado"}</code></dd></div></dl></article>
      <article className="state-comparison"><h3>Configurado vs observado</h3><div><section><small>Esperado</small><pre>{JSON.stringify(application.expectedState || {}, null, 2)}</pre></section><section><small>Observado</small><pre>{JSON.stringify(application.observedState || {}, null, 2)}</pre></section></div><p>JuanOS no sobrescribe cambios manuales sin confirmación.</p><div className="state-actions"><button onClick={() => acceptObserved.mutate()}>Sincronizar desde observado</button><button onClick={() => onTabChange("deployments")}>Restaurar con plan repair</button><button onClick={() => ignoreObserved.mutate()}>Ignorar 1 hora</button></div>{(acceptObserved.error || ignoreObserved.error) && <p className="form-error">{(acceptObserved.error || ignoreObserved.error).message}</p>}</article>
      {(detail.data.alerts || []).length > 0 && <article><h3>Necesita atención</h3>{detail.data.alerts.map((alert) => <p className={`alert-line ${alert.severity}`} key={alert.id}><AlertTriangle size={15} /> <span><strong>{alert.title}</strong><small>{alert.detail}</small></span></p>)}</article>}
    </div>}
    {tab === "deployments" && <DeploymentsView projects={projects} initialProjectId={projectId} initialOperation={initialOperation} />}
    {tab === "logs" && <OperationalLogsPanel projectId={projectId} />}
    {tab === "variables" && <EnvironmentsView projects={projects} initialProjectId={projectId} />}
    {tab === "services" && <div className="service-grid">{(detail.data.services || []).map((service) => <article key={service.id}><Layers3 size={18} /><div><strong>{service.name}</strong><small>{service.serviceType} · {service.status}</small><code>{service.workingDirectory}</code></div></article>)}</div>}
    {tab === "config" && <ProjectConfiguration key={application.id} application={application} services={detail.data.services || []} />}
    {tab === "terminal" && <TerminalView projects={projects} initialProjectId={projectId} />}
    {tab === "files" && <FilesView projects={projects} initialProjectId={projectId} />}
  </section>;
}

function OperationsCenter({ projects, initialTab = "alerts", initialOperation = "update", onTabChange, onOpenSslPlan }) {
  const queryClient = useQueryClient();
  const tab = initialTab;
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => api("/alerts"), enabled: tab === "alerts" });
  const certificates = useQuery({ queryKey: ["certificates"], queryFn: () => api("/certificates"), enabled: tab === "ssl" });
  const recovery = useQuery({ queryKey: ["recovery"], queryFn: () => api("/recovery-snapshots"), enabled: tab === "recovery" });
  const acknowledge = useMutation({
    mutationFn: (id) => api(`/alerts/${id}/acknowledge`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] })
  });
  return <section className="operations-center">
    <div className="deploy-head"><div><span className="eyebrow">Historial y atención</span><h1>Actividad</h1></div></div>
    <nav className="detail-tabs"><button className={tab === "alerts" ? "active" : ""} onClick={() => onTabChange("alerts")}><Bell size={14} /> Alertas</button><button className={tab === "deployments" ? "active" : ""} onClick={() => onTabChange("deployments")}><Rocket size={14} /> Despliegues</button><button className={tab === "ssl" ? "active" : ""} onClick={() => onTabChange("ssl")}><LockKeyhole size={14} /> SSL</button><button className={tab === "recovery" ? "active" : ""} onClick={() => onTabChange("recovery")}><HardDrive size={14} /> Recovery</button></nav>
    {tab === "alerts" && <div className="alert-center">{(alerts.data?.alerts || []).map((alert) => <article className={alert.severity} key={alert.id}><AlertTriangle size={18} /><div><strong>{alert.title}</strong><small>{alert.applicationName || "VPS"} · {alert.detail}</small></div><button onClick={() => acknowledge.mutate(alert.id)}>Reconocer</button></article>)}{!alerts.isPending && !alerts.data?.alerts?.length && <div className="feature-empty compact-empty"><ShieldCheck size={28} /><strong>Sin alertas abiertas</strong><span>No hay incidencias materializadas por el worker.</span></div>}</div>}
    {tab === "deployments" && <DeploymentsView projects={projects} initialOperation={initialOperation} />}
    {tab === "ssl" && <div className="certificate-grid">
      {(certificates.data?.certificates || []).map((certificate) => <article key={certificate.id}>
        <LockKeyhole size={19} />
        <div>
          <strong>{certificate.domain}</strong>
          <small>{certificate.applicationName || "Dominio aún no asociado"} · {certificate.issuer || "emisor no observado"}</small>
          <span className="certificate-meta">
            <time>{certificate.expiresAt ? `Vence el ${new Date(certificate.expiresAt).toLocaleDateString()}` : "Fecha de vencimiento no verificada"}</time>
            <small>{certificate.autoRenewConfigured ? "Renovación automática detectada" : "Renovación automática no confirmada"}</small>
            <small>Última prueba: {certificate.error || certificate.lastRenewalResult || "sin ejecutar"}</small>
          </span>
        </div>
        <b className={certificate.daysRemaining !== null && certificate.daysRemaining <= 7 ? "critical" : certificate.daysRemaining !== null && certificate.daysRemaining <= 30 ? "warning" : ""}>{certificate.daysRemaining === null ? "No verificado" : `${certificate.daysRemaining} días`}</b>
        <button className="secondary-button compact-action" onClick={() => onOpenSslPlan(certificate.applicationId || "")}>{certificate.applicationId ? "Probar renovación" : "Elegir aplicación"}</button>
      </article>)}
      {!certificates.isPending && !certificates.data?.certificates?.length && <div className="feature-empty compact-empty"><LockKeyhole size={28} /><strong>Inventario SSL aún no observado</strong><span>El worker actualizará aquí los certificados detectados por Certbot.</span></div>}
      {certificates.error && <p className="form-error">{certificates.error.message}</p>}
      <button className="secondary-button" onClick={() => onOpenSslPlan("")}>Probar renovación desde un plan</button>
    </div>}
    {tab === "recovery" && <div className="recovery-grid">{(recovery.data?.snapshots || []).map((snapshot) => <article key={snapshot.id}><HardDrive size={19} /><div><strong>{snapshot.status} · {snapshot.verificationStatus}</strong><small>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.remoteProvider || "sin remoto"}</small><code>{snapshot.checksum?.slice(0, 16) || "sin checksum"}</code></div></article>)}<button className="secondary-button" onClick={() => onTabChange("deployments")}>Crear o probar recovery desde un plan</button></div>}
  </section>;
}

function SettingsView({ initialTab = "audit", onTabChange }) {
  const tab = initialTab;
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api("/audit") });
  const logs = useQuery({ queryKey: ["logs"], queryFn: () => api("/logs"), enabled: tab === "logs" });
  return <section className="audit-screen">
    <div className="deploy-head"><div><span className="eyebrow">Seguridad y diagnóstico</span><h1>{tab === "audit" ? "Auditoría" : "Logs permitidos"}</h1></div></div>
    <div className="settings-tabs"><button className={tab === "audit" ? "active" : ""} onClick={() => onTabChange("audit")}><ShieldCheck size={14} /> Auditoría</button><button className={tab === "logs" ? "active" : ""} onClick={() => onTabChange("logs")}><Activity size={14} /> Despliegues</button></div>
    {tab === "audit" ? <div className="deployment-list">{(audit.data?.entries || []).map((entry) => <article key={entry.id}><span className="activity-icon violet"><ShieldCheck size={15} /></span><div><strong>{entry.action}</strong><small>{entry.resourceType} · {entry.resourceId || "sistema"}</small></div><code>{entry.ipAddress || "local"}</code><time>{new Date(entry.createdAt).toLocaleString()}</time></article>)}</div>
      : <div className="allowed-logs">{(logs.data?.logs || []).map((entry) => <article key={entry.id}><header><strong>{entry.project}</strong><span className={`deployment-status ${entry.status}`} /> <b>{entry.status}</b><time>{new Date(entry.startedAt).toLocaleString()}</time></header><pre>{entry.output || entry.error || "Sin salida registrada."}</pre></article>)}{!logs.data?.logs?.length && <div className="feature-empty"><Activity size={28} /><strong>Sin logs de despliegue</strong><span>JuanOS no muestra logs globales del sistema.</span></div>}</div>}
  </section>;
}

function Dashboard({ user, onLogout }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigateTo = useNavigate();
  const { active, detail, subtab } = routeFromPath(location.pathname);
  const requestedOperation = new URLSearchParams(location.search).get("operation") || "update";
  const [showNewProject, setShowNewProject] = useState(false);
  const [showImportProject, setShowImportProject] = useState(false);
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api("/projects") });
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api("/overview") });
  const projects = projectsQuery.data?.projects || [];
  const removeProject = useMutation({
    mutationFn: (/** @type {{id: string, name: string}} */ project) => api(`/projects/${project.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    }
  });
  const alertCount = overview.data?.alerts?.total ?? projects.reduce((total, project) => total + (project.openAlerts || 0), 0);
  const navigate = (section) => {
    navigateTo(pathForSection(section));
  };
  const openDetail = (projectId, tab = "summary") => navigateTo(pathForProject(projectId, tab));
  const removeFromCatalog = (project) => {
    if (window.confirm(`¿Quitar “${project.name}” de JuanOS?\n\nSus archivos y servicios en la VPS no se modificarán.`)) {
      removeProject.mutate(project);
    }
  };
  const openSslPlan = (projectId) => navigateTo(
    projectId
      ? `${pathForProject(projectId, "deployments")}?operation=ssl_test`
      : `${pathForSubtab("Actividad", "deployments")}?operation=ssl_test`
  );
  const disk = overview.data?.disk;
  return (
    <div className="app-shell">
      <Sidebar active={active} setActive={navigate} onLogout={onLogout} projectCount={projects.length} />
      <main className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><Brand compact /></div>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{detail ? "Aplicación" : active}</strong></div>
          <div className="top-actions"><button className="status-pill"><i className={disk?.status === "critical" ? "off" : ""} /> {disk?.value ? `Disco ${disk.value.usedPercent}%` : "VPS no observada"}</button><button className="avatar" title={user.email}>JC</button></div>
        </header>
        <section className={`content ${active === "Terminal" || detail?.tab === "terminal" || detail?.tab === "files" ? "content-workbench" : ""}`}>
          {detail ? <ApplicationDetail projectId={detail.projectId} initialTab={detail.tab} initialOperation={requestedOperation} projects={projects} onBack={() => navigateTo("/projects")} onTabChange={(tab) => navigateTo(pathForProject(detail.projectId, tab))} />
            : active === "Terminal" ? <TerminalView projects={projects} />
              : active === "Actividad" ? <OperationsCenter projects={projects} initialTab={subtab} initialOperation={requestedOperation} onTabChange={(tab) => navigateTo(pathForSubtab("Actividad", tab))} onOpenSslPlan={openSslPlan} />
                : active === "Ajustes" ? <SettingsView initialTab={subtab} onTabChange={(tab) => navigateTo(pathForSubtab("Ajustes", tab))} /> : <>
          <div className="title-row">
            <div><span className="eyebrow">Operación de tu VPS</span><h1>{active === "Inicio" ? "Tu VPS, de un vistazo" : "Aplicaciones"}</h1><p>Estado configurado, estado observado y despliegues desde un solo lugar.</p></div>
            <div className="title-actions"><button className="secondary-button" onClick={() => setShowImportProject(true)}><Import size={17} /> Importar</button><button className="primary-button small" onClick={() => setShowNewProject(true)}><Plus size={18} /> Nueva</button></div>
          </div>
          <div className="summary-strip">
            <div><span className="summary-icon violet"><FolderGit2 size={18} /></span><p><small>Proyectos activos</small><strong>{projects.length}</strong></p></div>
            <div><span className="summary-icon green"><Activity size={18} /></span><p><small>Repositorios limpios</small><strong>{projects.filter((project) => project.repositoryStatus === "clean").length}</strong></p></div>
            <div><span className="summary-icon amber"><AlertTriangle size={18} /></span><p><small>Alertas abiertas</small><strong>{alertCount}</strong></p></div>
            <div><span className="summary-icon blue"><Server size={18} /></span><p><small>Disco VPS</small><strong>{disk?.value ? `${disk.value.usedPercent}%` : "No verificado"}</strong></p></div>
          </div>
          <div className="section-head"><h2>Tus aplicaciones</h2><span>{projects.length} registradas</span></div>
          {projectsQuery.isError && <div className="form-error">No se pudo cargar el catálogo: {projectsQuery.error.message}</div>}
          {!projectsQuery.isPending && !projects.length && <div className="feature-empty compact-empty"><FolderGit2 size={28} /><strong>No hay aplicaciones registradas</strong><span>Importa las que ya existen en la VPS o registra una nueva.</span><button className="secondary-button" onClick={() => setShowImportProject(true)}><Import size={16} /> Descubrir aplicaciones</button></div>}
          {removeProject.error && <p className="form-error">No se pudo quitar la aplicación: {removeProject.error.message}</p>}
          <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={navigate} onDetail={openDetail} onRemove={removeFromCatalog} removing={removeProject.isPending && removeProject.variables?.id === project.id} />)}</div>
          <section className="activity-panel">
            <div className="section-head"><h2>Estado de operación</h2><button onClick={() => navigate("Actividad")}>Ver actividad <ChevronRight size={15} /></button></div>
            <div className="activity-row"><span className="activity-icon green"><ShieldCheck size={17} /></span><div><strong>Fuente de verdad</strong><small>PostgreSQL · importaciones históricas de solo lectura</small></div><code>DB</code><time><Clock3 size={13} /> ahora</time></div>
            <div className="activity-row"><span className="activity-icon violet"><Rocket size={17} /></span><div><strong>Worker persistente</strong><small>Planes, pasos y locks recuperables</small></div><code>v1</code><time><Clock3 size={13} /> activo</time></div>
          </section>
          </>}
        </section>
      </main>
      <nav className="bottom-nav">{navItems.map(([label, Icon]) => <button key={label} aria-label={label} className={!detail && active === label ? "active" : ""} onClick={() => navigate(label)}><Icon size={20} /><span>{label}</span></button>)}</nav>
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
      {showImportProject && <ImportProjectModal onClose={() => setShowImportProject(false)} />}
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => onUnauthorized(() => {
    setUser(null);
    queryClient.clear();
  }), [queryClient]);
  useEffect(() => {
    api("/auth/me").then((data) => { setCsrfToken(data.csrfToken); setUser(data.user); }).catch(() => {}).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!user) return undefined;
    const checkSession = () => {
      api("/auth/me").then((data) => setCsrfToken(data.csrfToken)).catch(() => {});
    };
    const interval = window.setInterval(checkSession, 60_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkSession();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [user]);
  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken("");
      setUser(null);
      queryClient.clear();
    }
  };
  if (checking) return <div className="boot"><Brand /><span>Preparando espacio seguro…</span></div>;
  return user ? <Dashboard user={user} onLogout={logout} /> : <Login onSuccess={setUser} />;
}
