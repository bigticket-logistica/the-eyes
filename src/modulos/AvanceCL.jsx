import { useState, useEffect, useMemo, useCallback } from "react";
import { sbCL } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AVANCE DE RUTAS · CHILE
//
//  Todas las rutas del día con su avance, entregas, fallidas y las alertas que
//  calcula MELI. Lee vw_torre_avance_cl del Supabase de Chile, que se alimenta
//  de la extracción cada 5 minutos del VPS de Chile: la misma fuente que la
//  pestaña Avance de la Bitácora, así que las dos muestran los mismos números.
//
//  Cubre cuatro puntos de la lista de optimización (23-nov-2026):
//    10 · avance general de ruta, con fallidas
//     5 · fallidas de la jornada
//     4 · alerta de demora en ruta
//     7 · rutas con saca pendiente
//
//  Solo lectura: las rutas se trabajan en MELI y esta pantalla dice cómo van.
// ═══════════════════════════════════════════════════════════════════════════

// Las alertas que manda MELI, con el nombre que usa la torre. El orden es el
// de importancia: así se dibujan los chips de cada ruta.
const ALERTAS = [
  { campo: "alerta_ruta_demorada",        corto: "Demorada",         filtro: "demoradas" },
  { campo: "alerta_inactividad_vehiculo", corto: "Detenida",         filtro: "detenidas" },
  { campo: "alerta_saca_pendiente",       corto: "Saca pendiente",   filtro: "sacas" },
  { campo: "alerta_despacho_demorado",    corto: "Despacho tarde" },
  { campo: "alerta_stemout_demorado",     corto: "Stem-out tarde" },
  { campo: "alerta_parada_comercial",     corto: "Parada comercial" },
];

const FILTROS = [
  { id: "todas",     label: "Todas" },
  { id: "alerta",    label: "Con alerta" },
  { id: "demoradas", label: "Demoradas" },
  { id: "detenidas", label: "Detenidas" },
  { id: "sacas",     label: "Saca pendiente" },
  { id: "fallidas",  label: "Con fallidas" },
];

const alertasDe = (r) => ALERTAS.filter((a) => r[a.campo] === true);

// Avance de una ruta. Se prefiere el porcentaje de MELI; si no viene, se
// calcula con lo resuelto (entregado + fallido) sobre el total.
function avanceDe(r) {
  if (typeof r.progress_percent === "number") return Math.max(0, Math.min(100, r.progress_percent));
  const tot = r.pkg_total || 0;
  if (!tot) return 0;
  return Math.round((((r.pkg_delivered || 0) + (r.pkg_not_delivered || 0)) / tot) * 100);
}

// Trae todo de a mil: Supabase corta cada respuesta en 1000 filas sin avisar.
async function traerRutas() {
  const filas = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sbCL.from("vw_torre_avance_cl")
      .select("*")
      .order("service_center_id", { ascending: true })
      .order("id_ruta", { ascending: true })
      .range(i, i + 999);
    if (error) return { data: filas, error };
    filas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: filas, error: null };
}

function Barra({ pct }) {
  const color = pct >= 100 ? "#1D9E75" : pct >= 50 ? "var(--navy)" : "#C25A08";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 110 }}>
      <div style={{ flex: 1, height: 6, background: "#e8edf3", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 999 }} />
      </div>
      <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

function Chip({ children, fondo = "#fdecea", color = "#a32d2d" }) {
  return (
    <span style={{ background: fondo, color, fontSize: 10.5, fontWeight: 600, padding: "2px 7px",
      borderRadius: 999, whiteSpace: "nowrap" }}>{children}</span>
  );
}

export default function AvanceCL() {
  const [rutas, setRutas] = useState(null);
  const [error, setError] = useState(null);
  const [filtro, setFiltro] = useState("todas");
  const [filtroSC, setFiltroSC] = useState("");
  const [busca, setBusca] = useState("");
  const [visto, setVisto] = useState(null);

  const cargar = useCallback(async () => {
    if (!sbCL) { setError("Faltan las variables de Chile en el despliegue."); return; }
    const { data, error } = await traerRutas();
    if (error) { setError(error.message); return; }
    setError(null);
    setRutas(data);
    setVisto(new Date());
  }, []);

  useEffect(() => {
    cargar();
    // La extracción corre cada 5 minutos; releer cada minuto basta.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const centros = useMemo(() =>
    [...new Set((rutas || []).map((r) => r.service_center_id).filter(Boolean))].sort(), [rutas]);

  // Lo que pasa los filtros de centro y búsqueda; sobre esto se cuentan los
  // totales de arriba, para que cuadren con lo que se ve.
  const base = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (rutas || []).filter((r) =>
      (!filtroSC || r.service_center_id === filtroSC)
      && (!q || [r.id_ruta, r.driver_name, r.vehicle_license].some((v) => String(v || "").toLowerCase().includes(q))));
  }, [rutas, filtroSC, busca]);

  const resumen = useMemo(() => {
    const s = (k) => base.reduce((a, r) => a + (r[k] || 0), 0);
    const total = s("pkg_total"), entregados = s("pkg_delivered"), fallidas = s("pkg_not_delivered");
    return {
      rutas: base.length,
      avance: total ? Math.round(((entregados + fallidas) / total) * 100) : 0,
      entregados, fallidas, pendientes: s("pkg_pending"),
      conAlerta: base.filter((r) => alertasDe(r).length).length,
    };
  }, [base]);

  const conteo = useMemo(() => {
    const c = { todas: base.length, alerta: 0, fallidas: 0, demoradas: 0, detenidas: 0, sacas: 0 };
    for (const r of base) {
      const al = alertasDe(r);
      if (al.length) c.alerta++;
      if ((r.pkg_not_delivered || 0) > 0) c.fallidas++;
      for (const a of al) if (a.filtro) c[a.filtro]++;
    }
    return c;
  }, [base]);

  // Agrupado por centro. Dentro de cada centro, primero las rutas con alerta,
  // después las más atrasadas. Los centros con más alertas van arriba.
  const grupos = useMemo(() => {
    const pasa = (r) => {
      const al = alertasDe(r);
      if (filtro === "todas") return true;
      if (filtro === "alerta") return al.length > 0;
      if (filtro === "fallidas") return (r.pkg_not_delivered || 0) > 0;
      return al.some((a) => a.filtro === filtro);
    };
    const porSC = new Map();
    for (const r of base.filter(pasa)) {
      const k = r.service_center_id || "—";
      if (!porSC.has(k)) porSC.set(k, []);
      porSC.get(k).push(r);
    }
    const lista = [...porSC.entries()].map(([sc, rs]) => {
      rs.sort((a, b) => alertasDe(b).length - alertasDe(a).length || avanceDe(a) - avanceDe(b));
      const tot = rs.reduce((x, r) => x + (r.pkg_total || 0), 0);
      const res = rs.reduce((x, r) => x + (r.pkg_delivered || 0) + (r.pkg_not_delivered || 0), 0);
      return {
        sc, rutas: rs,
        avance: tot ? Math.round((res / tot) * 100) : 0,
        fallidas: rs.reduce((x, r) => x + (r.pkg_not_delivered || 0), 0),
        alertas: rs.filter((r) => alertasDe(r).length).length,
      };
    });
    return lista.sort((a, b) => b.alertas - a.alertas || a.sc.localeCompare(b.sc));
  }, [base, filtro]);

  if (error) {
    return <div style={{ padding: 20, color: "#791F1F", fontSize: 13 }}>
      No se pudo leer el avance de Chile: {error}
    </div>;
  }
  if (rutas === null) {
    return <div style={{ padding: 20, color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>;
  }

  const Kpi = ({ titulo, valor, color }) => (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
      padding: "9px 14px", minWidth: 110 }}>
      <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>{titulo}</div>
      <div style={{ fontSize: 21, fontWeight: 600, color: color || "inherit",
        fontVariantNumeric: "tabular-nums" }}>{valor}</div>
    </div>
  );

  const th = { padding: "6px 10px", fontWeight: 600 };
  const td = { padding: "7px 10px" };

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>Avance de rutas · Chile</strong>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>rutas del día, datos de MELI cada 5 min</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--texto-tenue)" }}>
          {visto ? `visto ${visto.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi titulo="Rutas" valor={resumen.rutas} />
        <Kpi titulo="Avance" valor={`${resumen.avance}%`} />
        <Kpi titulo="Entregados" valor={resumen.entregados} color="#1D9E75" />
        <Kpi titulo="Fallidas" valor={resumen.fallidas} color={resumen.fallidas ? "#a32d2d" : undefined} />
        <Kpi titulo="Pendientes" valor={resumen.pendientes} />
        <Kpi titulo="Rutas con alerta" valor={resumen.conAlerta}
          color={resumen.conAlerta ? "#C25A08" : "#1D9E75"} />
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {FILTROS.map((f) => (
          <button key={f.id} onClick={() => setFiltro(f.id)}
            style={{
              fontSize: 12, padding: "5px 10px", borderRadius: 999, cursor: "pointer",
              border: filtro === f.id ? "1px solid var(--navy)" : "1px solid var(--borde)",
              background: filtro === f.id ? "var(--navy)" : "#fff",
              color: filtro === f.id ? "#fff" : "inherit",
            }}>
            {f.label} <span style={{ opacity: 0.7 }}>{conteo[f.id]}</span>
          </button>
        ))}
        <select value={filtroSC} onChange={(e) => setFiltroSC(e.target.value)}
          style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 7, marginLeft: 6,
            border: "1px solid var(--borde)", background: "#fff" }}>
          <option value="">Todos los centros</option>
          {centros.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
        </select>
        <input value={busca} onChange={(e) => setBusca(e.target.value)}
          placeholder="Ruta, conductor o patente"
          style={{ fontSize: 12.5, padding: "5px 9px", borderRadius: 7, minWidth: 190,
            border: "1px solid var(--borde)" }} />
      </div>

      {grupos.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)", fontSize: 13,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10 }}>
          {rutas.length ? "Ninguna ruta con este filtro." : "Todavía no hay rutas capturadas hoy."}
        </div>
      ) : grupos.map((g) => (
        <div key={g.sc} style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          overflow: "hidden", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px",
            background: "var(--fondo, #f7f8fa)", borderBottom: "1px solid var(--borde)" }}>
            <strong style={{ fontSize: 13 }}>{g.sc}</strong>
            <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>
              {g.rutas.length} {g.rutas.length === 1 ? "ruta" : "rutas"} · avance {g.avance}%
            </span>
            {g.fallidas > 0 && <Chip>{g.fallidas} fallidas</Chip>}
            {g.alertas > 0
              ? <Chip fondo="#fff4e5" color="#9a4d00">{g.alertas} con alerta</Chip>
              : <Chip fondo="#e7f6ef" color="#13724f">en regla</Chip>}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--texto-suave)", fontSize: 10.5,
                textTransform: "uppercase", letterSpacing: 0.3 }}>
                <th style={th}>Ruta</th>
                <th style={th}>Conductor</th>
                <th style={th}>Avance</th>
                <th style={{ ...th, textAlign: "right" }}>Entreg.</th>
                <th style={{ ...th, textAlign: "right" }}>Fallidas</th>
                <th style={{ ...th, textAlign: "right" }}>Pend.</th>
                <th style={th}>Alertas</th>
                <th style={{ ...th, textAlign: "right" }}>Dato</th>
              </tr>
            </thead>
            <tbody>
              {g.rutas.map((r) => {
                const al = alertasDe(r);
                const pct = avanceDe(r);
                return (
                  <tr key={r.id_ruta} style={{ borderTop: "1px solid var(--borde)" }}>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {/* El id arriba porque es con lo que se busca en MELI. */}
                      <div>{r.id_ruta}</div>
                      {r.cycle_name && <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{r.cycle_name}</div>}
                    </td>
                    <td style={td}>
                      <div>{r.driver_name || "—"}</div>
                      <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>
                        {r.vehicle_license || ""}{r.has_helper ? " · con ayudante" : ""}
                      </div>
                    </td>
                    <td style={td}><Barra pct={pct} /></td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.pkg_delivered ?? 0}<span style={{ color: "var(--texto-tenue)" }}>/{r.pkg_total ?? 0}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
                      color: r.pkg_not_delivered ? "#a32d2d" : "var(--texto-tenue)",
                      fontWeight: r.pkg_not_delivered ? 600 : 400 }}>
                      {r.pkg_not_delivered ?? 0}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.pkg_pending ?? 0}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {al.length === 0
                          ? <span style={{ color: "var(--texto-tenue)" }}>—</span>
                          : al.map((a) => <Chip key={a.campo}>{a.corto}</Chip>)}
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
                      whiteSpace: "nowrap" }}
                      title="Minutos desde la última captura de esta ruta">
                      {typeof r.hace_minutos === "number" ? `hace ${Math.round(r.hace_minutos)} min` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
