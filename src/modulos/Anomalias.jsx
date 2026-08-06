import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { diaMX } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// ANOMALÍAS · SECCIÓN 1 · RUTAS QUE NO CERRARON EN EL DÍA
//
// LA PREGUNTA
//   ¿Qué rutas seguían abiertas al cierre real del día (23:59) y qué pasó con
//   ellas después: cerraron, entregaron más y cerraron, o siguen abiertas?
//
// UNA ADVERTENCIA QUE LA PANTALLA MUESTRA SOLA
//   Hasta el 5-ago-2026 el monitor se apagaba a las 21:59, así que la foto de
//   esos días NO es del cierre real: rutas que cerraron a las 22:53 aparecen
//   como "abiertas" sin serlo. fn_calidad_dia dice hasta qué hora se miró y la
//   pantalla avisa cuando el día no es comparable, en vez de mostrar ruido como
//   si fuera información.
//
// TRES ESTADOS, NO SEIS
//   Cerró después entregando · cerró después sin entregar · sigue abierta.
//   Los fallidos son una MARCA sobre la fila (⚠), no una categoría: una ruta
//   puede entregar más Y además convertir pendientes en fallidos, y con
//   categorías excluyentes eso no se podía expresar.
// ═══════════════════════════════════════════════════════════════════════════

function ayerMX() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return diaMX(d);
}
const n0 = (v) => (v == null ? 0 : Number(v));
const pct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);

const ESTADOS = {
  cerro_despues_con_entregas: { txt: "Cerró después · entregó más", bg: "#ecfdf5", bd: "#a7f3d0", fg: "#15803d" },
  cerro_despues_sin_entregas: { txt: "Cerró después · sin entregas", bg: "#f1f5f9", bd: "var(--borde)", fg: "var(--texto-suave)" },
  sigue_abierta:              { txt: "Sigue abierta",               bg: "#fffbeb", bd: "#fde68a", fg: "#92400e" },
  pendiente_reconciliar:      { txt: "Por revisar",                 bg: "#f8fafc", bd: "var(--borde)", fg: "var(--texto-tenue)" },
  no_encontrada:              { txt: "No encontrada",               bg: "#f8fafc", bd: "var(--borde)", fg: "var(--texto-tenue)" },
};

function Tarjeta({ titulo, valor, detalle, tono, onClick, activa }) {
  const c = {
    alerta: { bg: "#fffbeb", bd: "#fde68a", fg: "#92400e" },
    grave:  { bg: "#fef2f2", bd: "#fca5a5", fg: "#b91c1c" },
    bueno:  { bg: "#ecfdf5", bd: "#a7f3d0", fg: "#15803d" },
    neutro: { bg: "#fff",    bd: "var(--borde)", fg: "var(--navy)" },
  }[tono || "neutro"];
  const clic = typeof onClick === "function";
  return (
    <div onClick={onClick} title={clic ? (activa ? "Quitar filtro" : "Filtrar") : undefined}
      style={{
        background: c.bg,
        border: `${activa ? 2 : 1}px solid ${activa ? "var(--navy)" : c.bd}`,
        borderRadius: 10, padding: activa ? "10px 12px" : "11px 13px",
        cursor: clic ? "pointer" : "default", minWidth: 0,
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

const th = { padding: "7px 9px", textAlign: "center", fontWeight: 600, fontSize: 10.5, whiteSpace: "nowrap" };
const td = { padding: "8px 9px", textAlign: "center" };

export default function Anomalias() {
  const [fecha, setFecha] = useState(ayerMX());
  const [filtro, setFiltro] = useState(null);
  const [rutas, setRutas] = useState(null);
  const [calidad, setCalidad] = useState(null);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setRutas(null); setError(null);
    const [a, q] = await Promise.all([
      sb.rpc("fn_anomalias_cierre", { p_fecha: fecha }),
      sb.rpc("fn_calidad_dia", { p_fecha: fecha }),
    ]);
    if (a.error || q.error) {
      const m = (a.error || q.error).message;
      setError(/does not exist|no existe/i.test(m)
        ? "Faltan funciones en la base. Corre cierre_v2_simple.sql."
        : m);
      setRutas([]);
      return;
    }
    setRutas(a.data || []);
    setCalidad(Array.isArray(q.data) ? q.data[0] : q.data);
  }, [fecha]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { setFiltro(null); }, [fecha]);

  const lista = rutas || [];
  const cuenta = (d) => lista.filter((r) => r.desenlace === d).length;
  const conEntregas = cuenta("cerro_despues_con_entregas");
  const sinEntregas = cuenta("cerro_despues_sin_entregas");
  const abiertas = cuenta("sigue_abierta");
  const porRevisar = cuenta("pendiente_reconciliar");
  const graves = lista.filter((r) => r.convirtio_pendientes).length;
  const recuperadas = lista.reduce((s, r) => s + n0(r.mas_entregas), 0);
  const convertidos = lista.filter((r) => r.convirtio_pendientes)
    .reduce((s, r) => s + n0(r.mas_fallidos), 0);

  const visibles = !filtro ? lista
    : filtro === "graves" ? lista.filter((r) => r.convirtio_pendientes)
    : lista.filter((r) => r.desenlace === filtro);

  const diaIncompleto = calidad && calidad.completo === false;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 18, background: "var(--fondo)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Anomalías</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>
            Situaciones que distorsionan las cifras del día
          </div>
        </div>
        <input type="date" value={fecha} max={diaMX()}
          onChange={(e) => setFecha(e.target.value || ayerMX())}
          style={{ fontSize: 12.5, padding: "7px 10px", border: "1px solid var(--borde)", borderRadius: 8 }} />
        <button onClick={() => setFecha(ayerMX())} style={{ fontSize: 12, padding: "7px 12px" }}>Ayer</button>
        <button onClick={cargar} style={{ fontSize: 12, padding: "7px 12px" }}>↻</button>
      </div>

      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
          1 · Rutas que no cerraron el {fecha}
        </div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", lineHeight: 1.55, maxWidth: 860 }}>
          Seguían abiertas al cierre del día. Se consulta a MELI qué pasó después: si cerraron
          entregando más, si cerraron sin entregar nada, o si siguen abiertas.
        </div>

        {/* Aviso de calidad: sin esto un día con monitor apagado a las 21:55 se
            ve igual que uno completo, y los números no son comparables. */}
        {diaIncompleto && (
          <div style={{
            fontSize: 12, background: "#fef2f2", border: "1px solid #fca5a5", color: "#b91c1c",
            borderRadius: 8, padding: "10px 12px", marginTop: 12, lineHeight: 1.5,
          }}>
            <b>Este día no es comparable.</b> El monitor solo alcanzó a mirar hasta las{" "}
            {calidad.ultima_captura}, no hasta las 23:59. Las rutas que cerraron después de esa
            hora aparecen acá como si hubieran quedado abiertas, y no es así. Los días desde el
            6 de agosto sí tienen la foto del cierre real.
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12.5, color: "#b91c1c", background: "#fef2f2",
            border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", margin: "12px 0" }}>
            {error}
          </div>
        )}

        {rutas === null ? (
          <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "20px 0" }}>Cargando…</div>
        ) : lista.length === 0 && !error ? (
          <div style={{ fontSize: 12.5, color: "#15803d", background: "#ecfdf5",
            border: "1px solid #a7f3d0", borderRadius: 8, padding: "12px 14px", marginTop: 12 }}>
            ✓ Todas las rutas del {fecha} cerraron dentro del día.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))",
              gap: 9, margin: "14px 0" }}>
              <Tarjeta titulo="Quedaron abiertas" valor={lista.length} detalle="ver todas"
                onClick={() => setFiltro(null)} activa={filtro === null} />
              <Tarjeta titulo="Cerraron entregando" valor={conEntregas}
                detalle={recuperadas > 0 ? `+${recuperadas} entregas` : "—"} tono="bueno"
                onClick={() => setFiltro(filtro === "cerro_despues_con_entregas" ? null : "cerro_despues_con_entregas")}
                activa={filtro === "cerro_despues_con_entregas"} />
              <Tarjeta titulo="Cerraron sin entregar" valor={sinEntregas} detalle="no movieron cifras"
                onClick={() => setFiltro(filtro === "cerro_despues_sin_entregas" ? null : "cerro_despues_sin_entregas")}
                activa={filtro === "cerro_despues_sin_entregas"} />
              <Tarjeta titulo="Siguen abiertas" valor={abiertas}
                detalle={porRevisar > 0 ? `${porRevisar} por revisar` : "requieren gestión"}
                tono={abiertas > 0 ? "alerta" : "neutro"}
                onClick={() => setFiltro(filtro === "sigue_abierta" ? null : "sigue_abierta")}
                activa={filtro === "sigue_abierta"} />
              <Tarjeta titulo="⚠ Pendientes → fallidos" valor={graves}
                detalle={convertidos > 0 ? `${convertidos} paquetes` : "ninguna"}
                tono={graves > 0 ? "grave" : "neutro"}
                onClick={() => setFiltro(filtro === "graves" ? null : "graves")}
                activa={filtro === "graves"} />
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--navy)", color: "#fff" }}>
                    <th style={{ ...th, textAlign: "left" }}>Ruta</th>
                    <th style={{ ...th, textAlign: "left" }}>SC</th>
                    <th style={{ ...th, textAlign: "left" }}>Conductor</th>
                    <th style={th}>Carg.</th>
                    <th style={{ ...th, borderLeft: "2px solid rgba(255,255,255,.3)" }}>Entreg.<br/>al cierre</th>
                    <th style={th}>Pend.<br/>al cierre</th>
                    <th style={th}>NS<br/>al cierre</th>
                    <th style={{ ...th, borderLeft: "2px solid rgba(255,255,255,.3)" }}>Entreg.<br/>final</th>
                    <th style={th}>NS<br/>final</th>
                    <th style={th}>Δ NS</th>
                    <th style={{ ...th, textAlign: "left", borderLeft: "2px solid rgba(255,255,255,.3)" }}>
                      Qué pasó
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((r) => {
                    const e = ESTADOS[r.desenlace] || ESTADOS.pendiente_reconciliar;
                    const dNs = r.delta_ns == null ? null : Number(r.delta_ns);
                    return (
                      <tr key={r.id_ruta} style={{
                        borderBottom: "1px solid var(--borde)",
                        background: r.convirtio_pendientes ? "#fffafa" : "transparent",
                      }}>
                        <td style={{ ...td, textAlign: "left", fontFamily: "monospace", fontSize: 11 }}>
                          {r.id_ruta}
                        </td>
                        <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{r.sc}</td>
                        <td style={{ ...td, textAlign: "left" }}>
                          {r.driver_name || "—"}
                          {r.vehicle_license && (
                            <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}> · {r.vehicle_license}</span>
                          )}
                        </td>
                        <td style={td}>{r.cargados}</td>

                        <td style={{ ...td, borderLeft: "2px solid var(--borde)" }}>{r.ent_cierre ?? "—"}</td>
                        <td style={{ ...td, color: n0(r.pend_cierre) > 0 ? "#b45309" : "var(--texto-tenue)" }}>
                          {r.pend_cierre ?? "—"}
                        </td>
                        <td style={{ ...td, color: "var(--texto-suave)" }}>{pct(r.ns_cierre)}</td>

                        <td style={{ ...td, borderLeft: "2px solid var(--borde)", fontWeight: 600 }}>
                          {r.ent_final ?? "—"}
                          {n0(r.mas_entregas) > 0 && (
                            <span style={{ color: "#15803d", fontSize: 10, fontWeight: 500 }}>
                              {" "}+{r.mas_entregas}
                            </span>
                          )}
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>{pct(r.ns_final)}</td>
                        <td style={{ ...td, fontWeight: 600,
                          color: dNs > 0 ? "#15803d" : dNs < 0 ? "#b91c1c" : "var(--texto-tenue)" }}>
                          {dNs == null ? "—" : dNs === 0 ? "0" : `${dNs > 0 ? "+" : ""}${dNs.toFixed(1)}`}
                        </td>

                        {/* Una sola columna en lenguaje natural en vez de cifras
                            sueltas que hay que interpretar */}
                        <td style={{ ...td, textAlign: "left", borderLeft: "2px solid var(--borde)" }}>
                          <span style={{
                            fontSize: 10.5, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap",
                            background: e.bg, border: `1px solid ${e.bd}`, color: e.fg,
                          }}>{e.txt}</span>
                          <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 3 }}>
                            {r.hora_cierre_meli
                              ? `cerró ${r.hora_cierre_meli}`
                              : r.status_final ? `MELI: ${r.status_final}` : "sin dato de cierre"}
                          </div>
                          {r.convirtio_pendientes && (
                            <div style={{ fontSize: 10.5, color: "#b91c1c", fontWeight: 600, marginTop: 2 }}>
                              ⚠ {r.mas_fallidos} pendientes → fallidos
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div style={{ background: "#fff", border: "1px dashed var(--borde)", borderRadius: 12,
        padding: 16, marginTop: 16, color: "var(--texto-tenue)", fontSize: 12.5 }}>
        2 · (pendiente de definir)
      </div>
    </div>
  );
}
