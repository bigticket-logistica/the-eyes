import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// ANOMALÍAS · SECCIÓN 2 · INTENTOS EN PAQUETES FALLIDOS
//
// UNA FILA POR PAQUETE, NO POR INTENTO
//   Antes cada intento era una fila y había que leer dos renglones para
//   entender un paquete: el primero mostraba "1 de 2" sin Δ y con un solo
//   motivo, y el segundo el resto. Agrupado por paquete se ve la historia
//   completa de una vez.
//   Y aparece algo que la vista anterior escondía: el paquete 47666901265 fue
//   intentado por DOS conductores en DOS rutas distintas. Con filas separadas
//   parecían dos hechos sin relación.
//
// LA COLUMNA Δ SEPARA LO REAL DE LO APARENTE
//   455 minutos es el conductor volviendo de verdad; 12 minutos es la misma
//   visita registrada dos veces. Sin ese dato los dos casos se ven iguales y se
//   le atribuye al conductor un reintento que no hizo.
//
// La fuente es el historial del paquete en MELI, no el Case Center: se comprobó
// que el Case Center pierde intentos y que sus horas son de creación del caso
// (20:10) y no del intento (17:09).
// ═══════════════════════════════════════════════════════════════════════════

const URL_TAREAS = import.meta.env.VITE_TAREAS_URL || "https://voz.bigticket.mx/tareas";
const n0 = (v) => (v == null ? 0 : Number(v));
const th = { padding: "7px 9px", textAlign: "left", fontWeight: 600, fontSize: 10.5, whiteSpace: "nowrap" };
const td = { padding: "8px 9px", fontSize: 11.5, verticalAlign: "top" };

function Tarjeta({ titulo, valor, detalle, tono, onClick, activa }) {
  const c = {
    grave:  { bg: "#fef2f2", bd: "#fca5a5", fg: "#b91c1c" },
    alerta: { bg: "#fffbeb", bd: "#fde68a", fg: "#92400e" },
    bueno:  { bg: "#ecfdf5", bd: "#a7f3d0", fg: "#15803d" },
    neutro: { bg: "#fff",    bd: "var(--borde)", fg: "var(--navy)" },
  }[tono || "neutro"];
  return (
    <div onClick={onClick} title={activa ? "Quitar filtro" : "Filtrar la tabla"}
      style={{
        background: c.bg,
        border: `${activa ? 2 : 1}px solid ${activa ? "var(--navy)" : c.bd}`,
        borderRadius: 10, padding: activa ? "10px 12px" : "11px 13px",
        cursor: "pointer", minWidth: 0,
      }}>
      <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginBottom: 3,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {titulo}{activa ? " ✕" : ""}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.fg, lineHeight: 1.05 }}>{valor}</div>
      {detalle && <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2 }}>{detalle}</div>}
    </div>
  );
}

export default function SeccionIntentos({ fecha }) {
  const [filas, setFilas] = useState(null);
  const [tarea, setTarea] = useState(null);
  const [error, setError] = useState(null);
  const [filtro, setFiltro] = useState(null);
  const canalRef = useRef(null);

  const cargar = useCallback(async () => {
    setError(null);
    const { data, error: e } = await sb.rpc("fn_intentos_fallidos_dia", { p_fecha: fecha });
    if (e) {
      setError(/does not exist|no existe/i.test(e.message)
        ? "Faltan funciones en la base. Corre tareas_e_intentos.sql." : e.message);
      setFilas([]);
      return;
    }
    setFilas(data || []);
  }, [fecha]);

  useEffect(() => { setFilas(null); setFiltro(null); cargar(); }, [cargar]);

  useEffect(() => {
    let vivo = true;
    sb.from("crm_tareas").select("*").eq("tipo", "historial_paquetes")
      .order("iniciada_en", { ascending: false }).limit(1)
      .then(({ data }) => { if (vivo) setTarea(data?.[0] || null); });
    canalRef.current = sb.channel("tareas-historial")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_tareas" }, (p) => {
        if (p.new?.tipo !== "historial_paquetes") return;
        setTarea(p.new);
        if (p.new.estado === "ok") cargar();
      })
      .subscribe();
    return () => { vivo = false; if (canalRef.current) sb.removeChannel(canalRef.current); };
  }, [cargar]);

  // ── Agrupar por paquete: la unidad de análisis es el paquete, no el intento ──
  const paquetes = useMemo(() => {
    const mapa = new Map();
    for (const f of filas || []) {
      if (!mapa.has(f.shipment_id)) {
        mapa.set(f.shipment_id, {
          shipment_id: f.shipment_id,
          sc: f.sc, id_ruta: f.id_ruta,
          driver_name: f.driver_name, vehicle_license: f.vehicle_license,
          devuelto: f.devuelto, total: n0(f.total_intentos),
          intentos: [],
        });
      }
      mapa.get(f.shipment_id).intentos.push(f);
    }
    for (const p of mapa.values()) {
      p.intentos.sort((a, b) => n0(a.intento) - n0(b.intento));
      p.rutasDistintas = new Set(p.intentos.map((i) => i.id_ruta).filter(Boolean)).size;
      p.tieneReintentoReal = p.intentos.some((i) => i.reintento_real === true);
      p.tieneDudoso = p.intentos.some((i) => i.reintento_real === false);
    }
    return [...mapa.values()].sort((a, b) => b.total - a.total || a.sc.localeCompare(b.sc));
  }, [filas]);

  const total = paquetes.length;
  const conReintento = paquetes.filter((p) => p.total > 1).length;
  const reales = paquetes.filter((p) => p.tieneReintentoReal).length;
  const dudosos = paquetes.filter((p) => p.tieneDudoso).length;
  const devueltos = paquetes.filter((p) => p.devuelto).length;
  const variasRutas = paquetes.filter((p) => p.rutasDistintas > 1).length;

  const visibles = !filtro ? paquetes
    : filtro === "reintento" ? paquetes.filter((p) => p.total > 1)
    : filtro === "reales"    ? paquetes.filter((p) => p.tieneReintentoReal)
    : filtro === "dudosos"   ? paquetes.filter((p) => p.tieneDudoso)
    : filtro === "devueltos" ? paquetes.filter((p) => p.devuelto)
    : paquetes;

  const corriendo = tarea?.estado === "corriendo";

  async function lanzar() {
    setError(null);
    try {
      const { data: ses } = await sb.auth.getSession();
      const token = ses?.session?.access_token;
      if (!token) throw new Error("Sesión expirada, vuelve a entrar");
      const r = await fetch(`${URL_TAREAS}/lanzar`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tipo: "historial_paquetes", fecha }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `Error ${r.status}`);
    } catch (e) { setError(e.message); }
  }

  const f = (k) => setFiltro(filtro === k ? null : k);

  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12,
      padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
            2 · Intentos en paquetes fallidos
          </div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", lineHeight: 1.55, maxWidth: 820 }}>
            Cada paquete que falló el {fecha}, con todos sus intentos: hora exacta, motivo y quién
            lo intentó. Leído del historial del paquete en MELI. Las tarjetas filtran la tabla.
          </div>
        </div>
        <button className="btn-navy" onClick={lanzar} disabled={corriendo}
          style={{ padding: "9px 16px", fontSize: 12.5, whiteSpace: "nowrap" }}>
          {corriendo ? "Analizando…" : "▶ Analizar el día"}
        </button>
      </div>

      {corriendo && (
        <div style={{ fontSize: 12, background: "#eff6ff", border: "1px solid #bfdbfe",
          color: "#1e40af", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          Consultando el historial de cada paquete en MELI. Avanza aunque cierres esta pantalla.
        </div>
      )}
      {tarea?.estado === "error" && (
        <div style={{ fontSize: 12, background: "#fef2f2", border: "1px solid #fca5a5",
          color: "#b91c1c", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          La última corrida falló: {tarea.error || "sin detalle"}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12.5, color: "#b91c1c", background: "#fef2f2",
          border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          {error}
        </div>
      )}

      {total > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))",
          gap: 9, margin: "14px 0" }}>
          <Tarjeta titulo="Paquetes fallidos" valor={total} detalle="ver todos"
            onClick={() => setFiltro(null)} activa={filtro === null} />
          <Tarjeta titulo="Con más de un intento" valor={conReintento}
            detalle={variasRutas > 0 ? `${variasRutas} en rutas distintas` : "mismo día"}
            onClick={() => f("reintento")} activa={filtro === "reintento"} />
          <Tarjeta titulo="Reintento real" valor={reales} detalle="más de 30 min después"
            tono="bueno" onClick={() => f("reales")} activa={filtro === "reales"} />
          <Tarjeta titulo="Reintento dudoso" valor={dudosos} detalle="menos de 30 min"
            tono={dudosos > 0 ? "alerta" : "neutro"} onClick={() => f("dudosos")}
            activa={filtro === "dudosos"} />
          <Tarjeta titulo="Devueltos al vendedor" valor={devueltos} detalle="no se entregaron"
            tono={devueltos > 0 ? "grave" : "neutro"} onClick={() => f("devueltos")}
            activa={filtro === "devueltos"} />
        </div>
      )}

      {filas === null ? (
        <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "20px 0" }}>Cargando…</div>
      ) : total === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--texto-suave)", background: "#f8fafc",
          border: "1px solid var(--borde)", borderRadius: 8, padding: 14, marginTop: 12 }}>
          Sin datos de intentos para el {fecha}. Aprieta <b>Analizar el día</b> para consultarlos en MELI.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 8 }}>
            {visibles.length} de {total} paquetes
          </div>

          <div style={{ overflowX: "auto", maxHeight: 560, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
                <tr style={{ background: "var(--navy)", color: "#fff" }}>
                  <th style={th}>SC</th>
                  <th style={th}>Ruta</th>
                  <th style={th}>Conductor</th>
                  <th style={th}>Placa</th>
                  <th style={th}>Paquete</th>
                  <th style={{ ...th, textAlign: "center" }}>Intentos</th>
                  <th style={th}>Detalle de cada intento</th>
                  <th style={{ ...th, textAlign: "center" }}>Devuelto</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((p) => (
                  <tr key={p.shipment_id} style={{
                    borderBottom: "1px solid var(--borde)",
                    background: p.devuelto ? "#fffafa" : p.total > 1 ? "#fbfdfb" : "transparent",
                  }}>
                    <td style={{ ...td, fontWeight: 600 }}>{p.sc}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>
                      {p.id_ruta ?? "—"}
                      {p.rutasDistintas > 1 && (
                        <div style={{ fontSize: 9.5, color: "#b45309", fontFamily: "inherit" }}>
                          +{p.rutasDistintas - 1} ruta más
                        </div>
                      )}
                    </td>
                    <td style={td}>{p.driver_name}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{p.vehicle_license}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{p.shipment_id}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <span style={{
                        fontSize: 12, fontWeight: 700,
                        color: p.total > 1 ? "#15803d" : "var(--texto-tenue)",
                      }}>{p.total}</span>
                    </td>

                    {/* Todos los intentos del paquete, uno por línea */}
                    <td style={td}>
                      {p.intentos.map((i, k) => (
                        <div key={k} style={{
                          display: "flex", alignItems: "baseline", gap: 7,
                          marginBottom: k < p.intentos.length - 1 ? 4 : 0,
                          paddingBottom: k < p.intentos.length - 1 ? 4 : 0,
                          borderBottom: k < p.intentos.length - 1 ? "1px dashed var(--borde)" : "none",
                        }}>
                          <span style={{
                            fontSize: 9.5, fontWeight: 700, color: "#fff", background: "var(--navy)",
                            borderRadius: 4, padding: "1px 5px", flexShrink: 0,
                          }}>{i.intento}</span>
                          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                            {i.hora}
                          </span>
                          {i.minutos_desde_anterior != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 600, flexShrink: 0,
                              color: i.reintento_real ? "#15803d" : "#b45309",
                            }}>
                              +{i.minutos_desde_anterior} min
                              {!i.reintento_real && " (dudoso)"}
                            </span>
                          )}
                          <span style={{ color: "var(--texto-suave)" }}>{i.motivo}</span>
                          {/* Si otro conductor hizo este intento, decirlo acá */}
                          {i.id_ruta !== p.id_ruta && (
                            <span style={{ fontSize: 10, color: "#b45309" }}>
                              · {i.driver_name} ({i.id_ruta})
                            </span>
                          )}
                        </div>
                      ))}
                    </td>

                    <td style={{ ...td, textAlign: "center" }}>
                      {p.devuelto && (
                        <span style={{
                          fontSize: 10.5, padding: "2px 7px", borderRadius: 20,
                          background: "#fef2f2", border: "1px solid #fca5a5", color: "#b91c1c",
                          whiteSpace: "nowrap",
                        }}>devuelto</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 8,
            maxWidth: 820, lineHeight: 1.5 }}>
            El <b>+N min</b> es el tiempo desde el intento anterior del mismo paquete. Sobre 30
            minutos se considera un reintento real; por debajo, la misma visita registrada dos
            veces. Cuando un intento lo hizo otro conductor, aparece su nombre y su ruta en la línea.
          </div>
        </>
      )}
    </div>
  );
}
