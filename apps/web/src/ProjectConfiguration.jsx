import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import { configurationForm, configurationReview, needsImportedConfigurationReview } from "./projectConfiguration.js";

const display = (value) => typeof value === "boolean" ? (value ? "Sí" : "No") : value || "Sin configurar";

export default function ProjectConfiguration({ application, services = [] }) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState(application);
  const [form, setForm] = useState(() => configurationForm(application));
  const [review, setReview] = useState(null);
  const [notice, setNotice] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [reloading, setReloading] = useState(false);
  const save = useMutation({
    mutationFn: (payload) => api(`/projects/${application.id}/configuration`, { method: "PATCH", body: JSON.stringify(payload) }),
    onSuccess: (data) => {
      const saved = { ...snapshot, ...data.application };
      setSnapshot(saved); setForm(configurationForm(saved)); setReview(null);
      setNotice(`Configuración guardada. ${data.invalidatedPlans || 0} planes pendientes anulados. Genera y revisa un plan nuevo antes de ejecutar.`);
      queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    }
  });
  const proposedReview = configurationReview(snapshot, form);
  const needsReview = needsImportedConfigurationReview(snapshot);
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setNotice(""); save.reset(); };
  async function reload() {
    setReloading(true); setReloadError("");
    try {
      const data = await api(`/projects/${application.id}`);
      setSnapshot(data.application); setForm(configurationForm(data.application)); setReview(null); save.reset(); setNotice("Configuración actual cargada. Revisa los cambios antes de guardar.");
    } catch (error) { setReloadError(error.message); }
    finally { setReloading(false); }
  }
  const disabled = save.isPending || reloading;
  return <section className="project-configuration">
    <div className="detail-summary">
      <article><h3>Ubicación gestionada</h3><dl><div><dt>Repositorio</dt><dd>{snapshot.repositoryUrl}</dd></div><div><dt>Checkout de JuanOS</dt><dd>{snapshot.localPath}</dd></div></dl><p className="configuration-note">Guardar estos ajustes no mueve el checkout ni cambia la unidad del servidor.</p></article>
      <article><h3>Servicio observado / legado</h3>{services.length ? <ul className="configuration-services">{services.map((service) => <li key={service.id || service.name}><strong>{service.name}</strong><code>{service.workingDirectory || "Ruta no informada"}</code></li>)}</ul> : <p className="configuration-note">No hay una ruta de servicio verificada en este registro.</p>}<p className="configuration-note">Valida que el servicio y Nginx usan el checkout esperado. Dos rutas distintas pueden representar el mismo bind mount; este formulario no cambia ni mueve servicios.</p></article>
    </div>
    <form className="configuration-form" onSubmit={(event) => { event.preventDefault(); if (proposedReview && !disabled) { setReview(proposedReview); save.reset(); } }}>
      <h3>Configuración del proyecto</h3>
      {needsReview && <p className="configuration-note">Este proyecto importado aún no tiene una configuración operativa revisada. Puedes confirmar los ajustes actuales sin cambiarlos; se revisarán completos antes de guardarlos.</p>}
      <fieldset disabled={disabled || Boolean(review)} className="configuration-fields">
        <label>Rama de despliegue<input required value={form.defaultBranch} onChange={(e) => update("defaultBranch", e.target.value)} maxLength={200} /></label>
        <label>Tipo de aplicación<select value={form.applicationType} onChange={(e) => update("applicationType", e.target.value)}>{["frontend", "backend", "fullstack", "django", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Estrategia<select value={form.strategy} onChange={(e) => update("strategy", e.target.value)}>{["static_nginx", "systemd", "pm2", "docker", "docker_compose"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Servicio principal<input required value={form.serviceName} onChange={(e) => update("serviceName", e.target.value)} maxLength={200} /><small>Nombre de unidad existente; guardar no crea ni modifica la unidad.</small></label>
        <label>Directorio de trabajo<input required value={form.workingDirectory} onChange={(e) => update("workingDirectory", e.target.value)} /><small>Relativo al checkout gestionado. Usa . para su raíz.</small></label>
        <label>URL de comprobación de salud<input type="url" value={form.healthUrl} required={Boolean(snapshot.healthCheck?.url)} onChange={(e) => update("healthUrl", e.target.value)} placeholder="https://app.example/health" /><small>Indica una URL real de la aplicación. Guardar no prueba su disponibilidad.</small></label>
        <label>Estado HTTP esperado<input type="number" min="100" max="599" required={Boolean(form.healthUrl)} disabled={!form.healthUrl} value={form.healthExpectedStatus} onChange={(e) => update("healthExpectedStatus", Number(e.target.value))} /></label>
        {(form.strategy === "static_nginx" || ["frontend", "fullstack"].includes(form.applicationType)) && <label>Carpeta generada del frontend<input required value={form.buildOutputDir} onChange={(e) => update("buildOutputDir", e.target.value)} /><small>Salida del build, por ejemplo dist. No es la ruta publicada de Nginx.</small></label>}
        {form.applicationType === "django" && <>
          <label>Entorno Python<input required value={form.pythonVenv} onChange={(e) => update("pythonVenv", e.target.value)} /><small>Ruta relativa, por ejemplo venv.</small></label>
          <label>Archivo de dependencias<input required value={form.requirements} onChange={(e) => update("requirements", e.target.value)} /></label>
          <label>Respaldo previo a migraciones<select value={form.backupStrategy} onChange={(e) => update("backupStrategy", e.target.value)}><option value="none">Sin estrategia configurada</option><option value="pg_dump_local">PostgreSQL local (pg_dump)</option>{!["none", "pg_dump_local"].includes(form.backupStrategy) && <option value={form.backupStrategy}>{form.backupStrategy} (configurada)</option>}</select><small>Seleccionarla no ejecuta ni verifica un respaldo.</small></label>
          <label className="configuration-checkbox"><input type="checkbox" checked={form.collectstatic} onChange={(e) => update("collectstatic", e.target.checked)} />Recopilar estáticos Django (collectstatic)</label>
        </>}
      </fieldset>
      <p className="configuration-note">Los demás ajustes se conservan. Los permisos del host no se editan aquí. Guardar anula los planes pendientes de confirmación; no ejecuta un despliegue.</p>
      {!review && <button className="primary-button" disabled={disabled || !proposedReview}>{needsReview ? "Revisar configuración actual" : "Revisar cambios"}</button>}
    </form>
    {review && <section className="configuration-review" aria-labelledby="configuration-review-title">
      <h3 id="configuration-review-title">{review.fullReview ? "Revisar configuración importada completa" : "Confirma los cambios"}</h3>
      {review.fullReview && <><p className="configuration-note">Confirma que estos valores operativos corresponden a la aplicación. No se copian automáticamente los datos del servicio legado ni se amplían permisos del host.</p><dl>{review.settings.map((setting) => <div key={setting.key}><dt>{setting.label}</dt><dd><pre>{display(setting.value)}</pre></dd></div>)}</dl></>}
      <dl>{review.changes.map((change) => <div key={change.key}><dt>{change.label}</dt><dd><span>Actual: {display(change.before)}</span><strong>Nuevo: {display(change.after)}</strong></dd></div>)}</dl>
      <div className="configuration-actions"><button disabled={disabled} className="primary-button" onClick={() => { if (!save.isPending) save.mutate(review.payload); }}>{save.isPending ? "Guardando…" : review.fullReview ? "Confirmar configuración revisada y guardar" : "Confirmar y guardar configuración"}</button><button disabled={disabled} onClick={() => { setReview(null); save.reset(); }}>Volver a editar</button></div>
    </section>}
    {(save.error || reloadError) && <div className="form-error" role="alert"><p>{save.error?.message || reloadError}</p><button disabled={disabled} onClick={reload}>Descartar edición y cargar configuración actual</button></div>}
    {notice && <p className="configuration-notice" role="status">{notice}</p>}
  </section>;
}
