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

// Todo se agrupa por el CECO del Brain, no por el centro que informa MELI: las
// rutas de Melipilla nacen en SRM2 pero se despachan desde ERM2, y agrupando
// por centro quedaban escondidas dentro de SRM2 (23-nov-2026). La vista ya trae
// el CECO del Brain, o el de respaldo si el Brain todavía no lo resolvió.
// Sin ninguno, la ruta queda bajo su centro de MELI marcada como pendiente,
// para que no desaparezca.
const claveCeco = (r) => r.ceco || `${r.service_center_id || "—"} · CECO pendiente`;

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

// ── Una fila de centro, con sus rutas debajo cuando está desplegada ─────────
function FilaCentro({ g, abierto, onClick, filtrando, th, td }) {
  const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
  return (
    <>
      <tr onClick={onClick} style={{ borderTop: "1px solid var(--borde)", cursor: "pointer",
        background: abierto ? "#f4f7fb" : "#fff" }}>
        <td style={{ ...td, color: "var(--texto-suave)", fontSize: 11 }}>{abierto ? "▾" : "▸"}</td>
        <td style={{ ...td, fontWeight: 600 }}>
          {g.sc}
          {g.origenes.length > 0 && (
            <span style={{ fontWeight: 400, fontSize: 11, color: "var(--texto-tenue)", marginLeft: 6 }}>
              {g.origenes.join(", ")}
            </span>
          )}
          {/* Con un filtro puesto se dice cuántas rutas del centro lo cumplen;
              el resumen de la fila sigue siendo del centro completo. */}
          {filtrando && (
            <span style={{ fontWeight: 400, fontSize: 11, color: "var(--texto-suave)", marginLeft: 6 }}>
              {g.visibles.length} con el filtro
            </span>
          )}
        </td>
        <td style={{ ...td, ...num }}>{g.rutas}</td>
        <td style={td}><Barra pct={g.avance} /></td>
        <td style={{ ...td, ...num }}>
          {g.entregados}<span style={{ color: "var(--texto-tenue)" }}>/{g.total}</span>
        </td>
        <td style={{ ...td, ...num, color: g.fallidas ? "#a32d2d" : "var(--texto-tenue)",
          fontWeight: g.fallidas ? 600 : 400 }}>{g.fallidas}</td>
        <td style={{ ...td, ...num }}>{g.pendientes}</td>
        <td style={td}>
          {g.alertas > 0
            ? <Chip fondo="#fff4e5" color="#9a4d00">{g.alertas} con alerta</Chip>
            : <Chip fondo="#e7f6ef" color="#13724f">en regla</Chip>}
        </td>
      </tr>
      {abierto && (
        <tr>
          <td colSpan={8} style={{ padding: "0 0 8px 28px", background: "#f4f7fb" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, background: "#fff",
              border: "1px solid var(--borde)", borderRadius: 8 }}>
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
                {g.visibles.map((r) => {
                  const al = alertasDe(r);
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
                      <td style={td}><Barra pct={avanceDe(r)} /></td>
                      <td style={{ ...td, ...num }}>
                        {r.pkg_delivered ?? 0}<span style={{ color: "var(--texto-tenue)" }}>/{r.pkg_total ?? 0}</span>
                      </td>
                      <td style={{ ...td, ...num, color: r.pkg_not_delivered ? "#a32d2d" : "var(--texto-tenue)",
                        fontWeight: r.pkg_not_delivered ? 600 : 400 }}>{r.pkg_not_delivered ?? 0}</td>
                      <td style={{ ...td, ...num }}>{r.pkg_pending ?? 0}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {al.length === 0
                            ? <span style={{ color: "var(--texto-tenue)" }}>—</span>
                            : al.map((a) => <Chip key={a.campo}>{a.corto}</Chip>)}
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
                        whiteSpace: "nowrap" }} title="Minutos desde la última captura de esta ruta">
                        {typeof r.hace_minutos === "number" ? `hace ${Math.round(r.hace_minutos)} min` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

export default function AvanceCL() {
  const [rutas, setRutas] = useState(null);
  const [error, setError] = useState(null);
  const [filtro, setFiltro] = useState("todas");
  const [filtroSC, setFiltroSC] = useState("");
  const [busca, setBusca] = useState("");
  const [visto, setVisto] = useState(null);
  // Centros desplegados. Arrancan todos plegados: con 9 centros y ~150 rutas,
  // la pantalla abierta entera no se puede leer. Se ve el resumen de cada
  // centro y se despliega el que interesa.
  const [abiertos, setAbiertos] = useState(() => new Set());
  const alternar = (sc) => setAbiertos((prev) => {
    const n = new Set(prev);
    if (n.has(sc)) n.delete(sc); else n.add(sc);
    return n;
  });

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
    [...new Set((rutas || []).map(claveCeco))].sort(), [rutas]);

  // Lo que pasa los filtros de centro y búsqueda; sobre esto se cuentan los
  // totales, para que cuadren con lo que se ve.
  const base = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (rutas || []).filter((r) =>
      (!filtroSC || claveCeco(r) === filtroSC)
      && (!q || [r.id_ruta, r.driver_name, r.vehicle_license].some((v) => String(v || "").toLowerCase().includes(q))));
  }, [rutas, filtroSC, busca]);

  const resumen = useMemo(() => {
    const s = (k) => base.reduce((a, r) => a + (r[k] || 0), 0);
    const total = s("pkg_total"), entregados = s("pkg_delivered"), fallidas = s("pkg_not_delivered");
    return {
      rutas: base.length,
      avance: total ? Math.round(((entregados + fallidas) / total) * 100) : 0,
      total, entregados, fallidas, pendientes: s("pkg_pending"),
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

  // Un grupo por centro. El resumen de la fila es del centro COMPLETO —todas
  // sus rutas—, para que el avance del centro no cambie según el filtro. Lo
  // que el filtro decide es qué rutas aparecen al desplegarlo, y qué centros
  // se muestran: con un filtro puesto, solo los que tienen alguna ruta que lo
  // cumpla. Los centros con más alertas van arriba.
  const grupos = useMemo(() => {
    const pasa = (r) => {
      const al = alertasDe(r);
      if (filtro === "todas") return true;
      if (filtro === "alerta") return al.length > 0;
      if (filtro === "fallidas") return (r.pkg_not_delivered || 0) > 0;
      return al.some((a) => a.filtro === filtro);
    };
    const porSC = new Map();
    for (const r of base) {
      const k = claveCeco(r);
      if (!porSC.has(k)) porSC.set(k, []);
      porSC.get(k).push(r);
    }
    const lista = [...porSC.entries()].map(([sc, todas]) => {
      const visibles = todas.filter(pasa)
        .sort((a, b) => alertasDe(b).length - alertasDe(a).length || avanceDe(a) - avanceDe(b));
      const sum = (k) => todas.reduce((x, r) => x + (r[k] || 0), 0);
      const tot = sum("pkg_total"), ent = sum("pkg_delivered"), fal = sum("pkg_not_delivered");
      return {
        sc, visibles,
        // Los centros de MELI de donde nacen sus rutas: SRM2 en Melipilla.
        origenes: [...new Set(todas.map((r) => r.service_center_id).filter(Boolean))].sort(),
        rutas: todas.length,
        avance: tot ? Math.round(((ent + fal) / tot) * 100) : 0,
        total: tot, entregados: ent, fallidas: fal, pendientes: sum("pkg_pending"),
        alertas: todas.filter((r) => alertasDe(r).length).length,
      };
    });
    return lista
      .filter((g) => filtro === "todas" || g.visibles.length > 0)
      .sort((a, b) => b.alertas - a.alertas || a.sc.localeCompare(b.sc));
  }, [base, filtro]);

  // Con una búsqueda escrita, los centros con coincidencias se abren solos:
  // quien busca un conductor quiere verlo, no un resumen.
  const buscando = busca.trim().length > 0;
  const estaAbierto = (sc) => buscando || abiertos.has(sc);

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
  const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const botonChico = { fontSize: 11.5, padding: "4px 9px", borderRadius: 7, cursor: "pointer",
    border: "1px solid var(--borde)", background: "#fff" };

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
          <option value="">Todos los CECO</option>
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
      ) : (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
            borderBottom: "1px solid var(--borde)" }}>
            <strong style={{ fontSize: 13 }}>Resumen por CECO</strong>
            <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>clic en un CECO para ver sus rutas</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button onClick={() => setAbiertos(new Set(grupos.map((g) => g.sc)))} style={botonChico}>
                Desplegar todos
              </button>
              <button onClick={() => setAbiertos(new Set())} style={botonChico}>Plegar todos</button>
            </span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--texto-suave)", fontSize: 10.5,
                textTransform: "uppercase", letterSpacing: 0.3, background: "var(--fondo, #f7f8fa)" }}>
                <th style={{ ...th, width: 22 }}></th>
                <th style={th}>CECO</th>
                <th style={{ ...th, textAlign: "right" }}>Rutas</th>
                <th style={th}>Avance</th>
                <th style={{ ...th, textAlign: "right" }}>Entreg.</th>
                <th style={{ ...th, textAlign: "right" }}>Fallidas</th>
                <th style={{ ...th, textAlign: "right" }}>Pend.</th>
                <th style={th}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {grupos.map((g) => (
                <FilaCentro key={g.sc} g={g} abierto={estaAbierto(g.sc)} onClick={() => alternar(g.sc)}
                  filtrando={filtro !== "todas"} th={th} td={td} />
              ))}
              {/* Total de lo que está a la vista: cuadra con los números de arriba. */}
              <tr style={{ borderTop: "2px solid var(--borde)", background: "var(--fondo, #f7f8fa)", fontWeight: 600 }}>
                <td style={td}></td>
                <td style={td}>Total</td>
                <td style={{ ...td, ...num }}>{resumen.rutas}</td>
                <td style={td}><Barra pct={resumen.avance} /></td>
                <td style={{ ...td, ...num }}>
                  {resumen.entregados}<span style={{ color: "var(--texto-tenue)", fontWeight: 400 }}>/{resumen.total}</span>
                </td>
                <td style={{ ...td, ...num, color: resumen.fallidas ? "#a32d2d" : undefined }}>{resumen.fallidas}</td>
                <td style={{ ...td, ...num }}>{resumen.pendientes}</td>
                <td style={td}>
                  {resumen.conAlerta
                    ? <Chip fondo="#fff4e5" color="#9a4d00">{resumen.conAlerta} con alerta</Chip>
                    : <Chip fondo="#e7f6ef" color="#13724f">en regla</Chip>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
