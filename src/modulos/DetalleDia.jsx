import { useEffect, useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { hace } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// DETALLE DÍA · Avance de rutas por SC (fuente: vw_rutas_mx_ultimo)
// La vista entrega UNA fila por ruta con su último estado conocido de HOY,
// capturado cada 5 min por the-eyes-mx (VPS The Eyes). Aquí solo se agrega.
// ═══════════════════════════════════════════════════════════════════════════

// Estados de MELI → etiqueta legible
const STATUS_RUTA = {
  planned:           { label: "Planificada",  bg: "#e0f2fe", color: "#075985" },
  active:            { label: "En ruta",      bg: "#fef3c7", color: "#92400e" },
  close:             { label: "Cerrada",      bg: "#dcfce7", color: "#166534" },
  return_to_station: { label: "Volviendo",    bg: "#f3e8ff", color: "#6b21a8" },
};
const estiloStatus = (s) => STATUS_RUTA[s] || { label: s || "—", bg: "#f1f5f9", color: "#475569" };

// Las 7 banderas de alerta → etiqueta corta para los badges
const ALERTAS = [
  { campo: "alerta_inactividad_vehiculo", label: "Sin actividad" },
  { campo: "alerta_ruta_demorada",        label: "Demorada" },
  { campo: "atraso_inicial",              label: "Atraso inicial" },
  { campo: "alerta_despacho_demorado",    label: "Despacho demorado" },
  { campo: "alerta_stemout_demorado",     label: "Stemout demorado" },
  { campo: "alerta_saca_pendiente",       label: "Saca pendiente" },
  { campo: "alerta_parada_comercial",     label: "Parada comercial" },
];
const alertasDe = (r) => ALERTAS.filter((a) => r[a.campo] === true);

const pct = (parte, total) => (total > 0 ? Math.round((100 * parte) / total) : 0);

function Kpi({ titulo, valor, sub, color }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "12px 16px", minWidth: 130 }}>
      <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>{titulo}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "var(--texto)" }}>{valor}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BarraAvance({ porcentaje }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: "#eef1f5", borderRadius: 5, overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${Math.min(100, porcentaje)}%`, height: "100%", background: porcentaje >= 100 ? "#16a34a" : "var(--navy)", borderRadius: 5 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>{porcentaje}%</span>
    </div>
  );
}

export default function DetalleDia() {
  const [rutas, setRutas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [scFiltro, setScFiltro] = useState("");

  const cargar = useCallback(async () => {
    setError("");
    const { data, error } = await sb.from("vw_rutas_mx_ultimo").select("*");
    if (error) { setError("No pudimos cargar el avance de rutas. Reintenta en unos segundos."); setCargando(false); return; }
    setRutas(data || []);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  if (cargando) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>Cargando…</div>;
  }

  // ── Agregados globales ────────────────────────────────────────────────────
  // El avance se mide sobre REPARTO (excluye line-haul), igual que el monitor.
  const reparto = rutas.filter((r) => r.is_line_haul === false);
  const entregados = reparto.reduce((a, r) => a + (r.pkg_delivered || 0), 0);
  const cargados   = reparto.reduce((a, r) => a + (r.pkg_total || 0), 0);
  const fallidos   = reparto.reduce((a, r) => a + (r.pkg_not_delivered || 0), 0);
  const activas    = rutas.filter((r) => r.status === "active").length;
  const cerradas   = rutas.filter((r) => r.status === "close").length;
  const detenidas  = rutas.filter((r) => r.alerta_inactividad_vehiculo === true && r.status !== "close");
  const demoradas  = rutas.filter((r) => (r.alerta_ruta_demorada === true || r.atraso_inicial === true) && r.status !== "close");
  const capturaMax = rutas.reduce((m, r) => (r.capturado_at > m ? r.capturado_at : m), "");

  // ── Agregado por SC ───────────────────────────────────────────────────────
  const porSC = {};
  for (const r of rutas) {
    const sc = r.service_center_id || "—";
    if (!porSC[sc]) porSC[sc] = { sc, rutas: 0, activas: 0, cerradas: 0, entregados: 0, total: 0, conAlerta: 0 };
    const g = porSC[sc];
    g.rutas++;
    if (r.status === "active") g.activas++;
    if (r.status === "close") g.cerradas++;
    if (r.is_line_haul === false) {
      g.entregados += r.pkg_delivered || 0;
      g.total += r.pkg_total || 0;
    }
    if ((r.alertas_activas || 0) > 0 && r.status !== "close") g.conAlerta++;
  }
  const listaSC = Object.values(porSC).sort((a, b) => a.sc.localeCompare(b.sc));

  // ── Rutas en problema (detenidas o demoradas, abiertas), con filtro por SC ─
  const problema = rutas
    .filter((r) => (r.alertas_activas || 0) > 0 && r.status !== "close")
    .filter((r) => !scFiltro || r.service_center_id === scFiltro)
    .sort((a, b) => (b.alertas_activas || 0) - (a.alertas_activas || 0));

  const sinDatos = rutas.length === 0;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      {/* Encabezado */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Detalle del día</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
            {sinDatos ? "Sin capturas todavía" : `Última captura ${hace(capturaMax)} · se actualiza cada 5 min`}
          </div>
        </div>
        <button onClick={cargar} style={{ fontSize: 12, padding: "6px 14px" }}>Actualizar</button>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>{error}</div>
      )}

      {sinDatos && !error && (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: 28, textAlign: "center", color: "var(--texto-suave)" }}>
          Aún no hay rutas capturadas hoy. El monitor corre de 6:00 a 21:59 CDMX; la primera captura del día aparece minutos después del primer despacho.
        </div>
      )}

      {!sinDatos && (
        <>
          {/* KPIs globales */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
            <Kpi titulo="Avance de reparto" valor={`${pct(entregados, cargados)}%`} sub={`${entregados.toLocaleString("es-MX")} / ${cargados.toLocaleString("es-MX")} paquetes`} color="var(--navy)" />
            <Kpi titulo="Rutas" valor={rutas.length} sub={`${activas} en ruta · ${cerradas} cerradas`} />
            <Kpi titulo="Detenidas" valor={detenidas.length} sub="sin actividad del vehículo" color={detenidas.length ? "#b91c1c" : "#16a34a"} />
            <Kpi titulo="Demoradas" valor={demoradas.length} sub="demora o atraso inicial" color={demoradas.length ? "#b45309" : "#16a34a"} />
            <Kpi titulo="No entregados" valor={fallidos.toLocaleString("es-MX")} sub="reparto de hoy" color={fallidos ? "#b45309" : undefined} />
          </div>

          {/* Tabla por SC */}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>Avance por Service Center</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                  <th style={{ padding: "8px 14px", fontWeight: 500 }}>SC</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Rutas</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>En ruta</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Cerradas</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Entregados / Total</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500, width: "26%" }}>Avance</th>
                  <th style={{ padding: "8px 14px", fontWeight: 500 }}>Con alerta</th>
                </tr>
              </thead>
              <tbody>
                {listaSC.map((g) => (
                  <tr key={g.sc}
                    onClick={() => setScFiltro(scFiltro === g.sc ? "" : g.sc)}
                    style={{ borderTop: "1px solid var(--borde)", cursor: "pointer",
                      background: scFiltro === g.sc ? "var(--naranja-suave)" : "transparent" }}
                    title="Clic para filtrar las rutas en problema por este SC">
                    <td style={{ padding: "9px 14px", fontWeight: 600 }}>{g.sc}</td>
                    <td style={{ padding: "9px 10px" }}>{g.rutas}</td>
                    <td style={{ padding: "9px 10px" }}>{g.activas}</td>
                    <td style={{ padding: "9px 10px" }}>{g.cerradas}</td>
                    <td style={{ padding: "9px 10px" }}>{g.entregados.toLocaleString("es-MX")} / {g.total.toLocaleString("es-MX")}</td>
                    <td style={{ padding: "9px 10px" }}><BarraAvance porcentaje={pct(g.entregados, g.total)} /></td>
                    <td style={{ padding: "9px 14px" }}>
                      {g.conAlerta > 0
                        ? <span className="pill" style={{ background: "#FCEBEB", color: "#791F1F" }}>{g.conAlerta}</span>
                        : <span style={{ color: "var(--texto-tenue)" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Rutas en problema */}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)", display: "flex", alignItems: "center", gap: 8 }}>
              Rutas detenidas o con demora
              <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}>({problema.length})</span>
              {scFiltro && (
                <button onClick={() => setScFiltro("")} style={{ fontSize: 11, padding: "2px 10px", marginLeft: 6 }}>
                  {scFiltro} ✕
                </button>
              )}
            </div>

            {problema.length === 0 ? (
              <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
                {scFiltro ? `Sin rutas en problema en ${scFiltro} ahora mismo.` : "Ninguna ruta con alertas activas ahora mismo. 👌"}
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                    <th style={{ padding: "8px 14px", fontWeight: 500 }}>Ruta</th>
                    <th style={{ padding: "8px 10px", fontWeight: 500 }}>SC</th>
                    <th style={{ padding: "8px 10px", fontWeight: 500 }}>Conductor</th>
                    <th style={{ padding: "8px 10px", fontWeight: 500 }}>Patente</th>
                    <th style={{ padding: "8px 10px", fontWeight: 500 }}>Estado</th>
                    <th style={{ padding: "8px 10px", fontWeight: 500 }}>Paquetes</th>
                    <th style={{ padding: "8px 14px", fontWeight: 500 }}>Alertas</th>
                  </tr>
                </thead>
                <tbody>
                  {problema.map((r) => {
                    const st = estiloStatus(r.status);
                    return (
                      <tr key={r.id_ruta} style={{ borderTop: "1px solid var(--borde)" }}>
                        <td style={{ padding: "9px 14px", fontWeight: 600 }}>{r.id_ruta}{r.cycle_name ? <span style={{ fontWeight: 400, color: "var(--texto-tenue)" }}> · {r.cycle_name}</span> : null}</td>
                        <td style={{ padding: "9px 10px" }}>{r.service_center_id || "—"}</td>
                        <td style={{ padding: "9px 10px" }}>{r.driver_name || "—"}</td>
                        <td style={{ padding: "9px 10px" }}>{r.vehicle_license || "—"}</td>
                        <td style={{ padding: "9px 10px" }}>
                          <span className="pill" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                        </td>
                        <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                          {(r.pkg_delivered ?? "—")} / {(r.pkg_total ?? "—")}
                          {r.pkg_not_delivered > 0 && <span style={{ color: "#b45309" }}> · {r.pkg_not_delivered} fallidos</span>}
                        </td>
                        <td style={{ padding: "9px 14px" }}>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {alertasDe(r).map((a) => (
                              <span key={a.campo} className="pill" style={{
                                background: a.campo === "alerta_inactividad_vehiculo" ? "#FCEBEB" : "#FAEEDA",
                                color: a.campo === "alerta_inactividad_vehiculo" ? "#791F1F" : "#633806",
                              }}>{a.label}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
