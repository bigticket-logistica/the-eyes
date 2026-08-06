import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { diaMX } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// ANOMALÍAS · cosas que distorsionan las cifras del día y hay que revisar
//
// SECCIÓN 1 · CIERRE TARDÍO
//   Hay rutas que no alcanzan a cerrar y se les da la mañana siguiente para
//   terminar. Eso mueve el NS en dos direcciones a la vez:
//     · el día original queda subestimado (cerró con entregas que faltaban)
//     · el día siguiente se contamina (el monitor crea filas con la fecha nueva,
//       así que la ruta se cuenta otra vez con cargados y entregados ajenos)
//
//   Esta sección muestra, para un día dado: qué rutas quedaron abiertas, con
//   cuánto pendiente, y qué pasó después — cerró aportando entregas, cerró sin
//   cambios, o sigue abierta.
//
//   El NS de cierre y el definitivo se muestran juntos a propósito: el primero
//   es lo que se reportó, el segundo el resultado real. Tener los dos evita la
//   discusión de "cuál era el número bueno".
// ═══════════════════════════════════════════════════════════════════════════

function ayerMX() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return diaMX(d);
}

const n0 = (v) => (v == null ? 0 : Number(v));

function Tarjeta({ titulo, valor, detalle, tono }) {
  const colores = {
    alerta: { bg: "#fffbeb", borde: "#fde68a", txt: "#92400e" },
    bueno:  { bg: "#ecfdf5", borde: "#a7f3d0", txt: "#15803d" },
    neutro: { bg: "#fff",    borde: "var(--borde)", txt: "var(--navy)" },
  }[tono || "neutro"];
  return (
    <div style={{
      background: colores.bg, border: `1px solid ${colores.borde}`, borderRadius: 10,
      padding: "12px 15px", minWidth: 145, flex: "1 1 145px",
    }}>
      <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>{titulo}</div>
      <div style={{ fontSize: 23, fontWeight: 700, color: colores.txt, lineHeight: 1.1 }}>{valor}</div>
      {detalle && <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 3 }}>{detalle}</div>}
    </div>
  );
}

// El desenlace viene calculado en la base (fn_rutas_abiertas), no se deduce acá.
// Son cuatro casos y la diferencia entre los dos últimos es la que importa:
//   sigue_abierta   → la vemos en MELI y no ha cerrado: PROBLEMA OPERATIVO
//   sin_seguimiento → desapareció de la lista cuando el monitor se apagó:
//                     no sabemos qué pasó. Es un punto ciego, no un problema.
// Mostrarlos iguales haría que la torre persiga rutas que probablemente
// cerraron bien, y que desconfíe de la pestaña.
const DESENLACES = {
  cerro_con_entregas: { etiqueta: "Cerró con entregas", bg: "#ecfdf5", borde: "#a7f3d0", color: "#15803d" },
  cerro_sin_cambios:  { etiqueta: "Cerró sin cambios",  bg: "#f1f5f9", borde: "var(--borde)", color: "var(--texto-suave)" },
  sigue_abierta:      { etiqueta: "Sigue abierta",      bg: "#fef2f2", borde: "#fca5a5", color: "#b91c1c" },
  sin_seguimiento:    { etiqueta: "Sin seguimiento",    bg: "#fffbeb", borde: "#fde68a", color: "#92400e" },
};

function desenlace(r) {
  const base = DESENLACES[r.desenlace] || DESENLACES.sin_seguimiento;
  const tardias = n0(r.entregas_tardias);
  if (r.desenlace === "cerro_con_entregas") {
    return { ...base, etiqueta: `Cerró · +${tardias} entrega${tardias === 1 ? "" : "s"}` };
  }
  return base;
}

const pct = (ent, tot) => (n0(tot) > 0 ? (100 * n0(ent) / n0(tot)).toFixed(1) : "—");

export default function Anomalias() {
  const [fecha, setFecha] = useState(ayerMX());
  const [rutas, setRutas] = useState(null);
  const [nsCierre, setNsCierre] = useState([]);
  const [nsDef, setNsDef] = useState([]);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setRutas(null); setError(null);
    const [a, c, d] = await Promise.all([
      sb.rpc("fn_rutas_abiertas", { p_fecha: fecha }),
      sb.rpc("fn_ns_por_sc", { p_fecha: fecha }),
      sb.rpc("fn_ns_por_sc_definitivo", { p_fecha: fecha }),
    ]);
    const err = a.error || c.error || d.error;
    if (err) {
      setError(
        /does not exist|no existe/i.test(err.message)
          ? "Faltan las funciones de cierre tardío en la base. Corre ns_cierre_tardio.sql."
          : err.message,
      );
      setRutas([]);
      return;
    }
    setRutas(a.data || []);
    setNsCierre(c.data || []);
    setNsDef(d.data || []);
  }, [fecha]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── Resumen ───────────────────────────────────────────────────────────────
  const total = rutas?.length || 0;
  const cuenta = (d) => (rutas || []).filter((r) => r.desenlace === d).length;
  const resueltas = cuenta("cerro_con_entregas") + cuenta("cerro_sin_cambios");
  const abiertas = cuenta("sigue_abierta");
  const sinSeguimiento = cuenta("sin_seguimiento");
  const tardias = (rutas || []).reduce((s, r) => s + n0(r.entregas_tardias), 0);
  // paquetes que quedaron sin entregar en rutas que siguen abiertas de verdad
  const pendientesVivos = (rutas || [])
    .filter((r) => r.desenlace === "sigue_abierta")
    .reduce((s, r) => s + n0(r.pendientes_cierre), 0);
  const pendientesCiegos = (rutas || [])
    .filter((r) => r.desenlace === "sin_seguimiento")
    .reduce((s, r) => s + n0(r.pendientes_cierre), 0);

  // NS global del día, con y sin las entregas tardías
  const tot = (arr, k) => arr.reduce((s, x) => s + n0(x[k]), 0);
  const nsCierreGlobal = pct(tot(nsCierre, "entregados"), tot(nsCierre, "total"));
  const nsDefGlobal = pct(tot(nsDef, "entregados"), tot(nsDef, "total"));
  const delta = (nsCierreGlobal !== "—" && nsDefGlobal !== "—")
    ? (Number(nsDefGlobal) - Number(nsCierreGlobal)).toFixed(1) : null;

  // Comparativo por SC, solo donde hay diferencia
  const porSc = nsDef.map((d) => {
    const c = nsCierre.find((x) => x.sc === d.sc);
    const nsC = c ? Number(c.ns) : null;
    const nsD = d.ns != null ? Number(d.ns) : null;
    return {
      sc: d.sc, nsC, nsD,
      dif: (nsC != null && nsD != null) ? +(nsD - nsC).toFixed(1) : null,
      rutas: n0(d.rutas), tardias: n0(d.entregas_tardias),
      rutasTardias: n0(d.rutas_cierre_tardio),
    };
  }).filter((x) => x.rutasTardias > 0 || (x.dif != null && x.dif !== 0));

  return (
    <div style={{ padding: 18, overflowY: "auto", background: "var(--fondo)", minHeight: 0 }}>
      {/* Cabecera */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
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

      {/* ══ SECCIÓN 1 · CIERRE TARDÍO ══ */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>1 · Rutas de cierre tardío</span>
          <span style={{ fontSize: 11.5, color: "var(--texto-tenue)" }}>
            no cerraron el {fecha} y se les dio la mañana siguiente
          </span>
        </div>

        {error && (
          <div style={{
            fontSize: 12.5, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fca5a5",
            borderRadius: 8, padding: "10px 12px", margin: "10px 0",
          }}>{error}</div>
        )}

        {rutas === null ? (
          <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "20px 0" }}>Cargando…</div>
        ) : total === 0 && !error ? (
          <div style={{
            fontSize: 12.5, color: "#15803d", background: "#ecfdf5", border: "1px solid #a7f3d0",
            borderRadius: 8, padding: "12px 14px", marginTop: 10,
          }}>
            ✓ Todas las rutas del {fecha} cerraron dentro de su propio día. No hay distorsión de NS por este motivo.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0" }}>
              <Tarjeta titulo="Quedaron abiertas" valor={total} detalle={`al cerrar el ${fecha}`} />
              <Tarjeta titulo="Resueltas" valor={resueltas}
                detalle={`${cuenta("cerro_con_entregas")} con entregas nuevas`}
                tono={resueltas > 0 ? "bueno" : "neutro"} />
              <Tarjeta titulo="Siguen abiertas" valor={abiertas}
                detalle={pendientesVivos > 0 ? `${pendientesVivos} paquetes sin entregar` : "requieren gestión"}
                tono={abiertas > 0 ? "alerta" : "bueno"} />
              <Tarjeta titulo="Sin seguimiento" valor={sinSeguimiento}
                detalle={sinSeguimiento > 0 ? "el monitor no las vio cerrar" : "—"}
                tono={sinSeguimiento > 0 ? "alerta" : "neutro"} />
              <Tarjeta titulo="Entregas tardías" valor={tardias}
                detalle="no contadas en el NS de cierre" tono={tardias > 0 ? "bueno" : "neutro"} />
              <Tarjeta titulo="NS de cierre" valor={`${nsCierreGlobal}%`}
                detalle="congelado, lo que se reportó" />
              <Tarjeta titulo="NS definitivo" valor={`${nsDefGlobal}%`}
                detalle={delta != null && Number(delta) !== 0
                  ? `${Number(delta) > 0 ? "+" : ""}${delta} pts vs cierre`
                  : "sin diferencia"}
                tono={delta != null && Number(delta) > 0 ? "bueno" : "neutro"} />
            </div>

            {sinSeguimiento > 0 && (
              <div style={{
                fontSize: 11.5, background: "#fffbeb", border: "1px solid #fde68a",
                color: "#92400e", borderRadius: 8, padding: "9px 12px", marginBottom: 12,
                lineHeight: 1.5, maxWidth: 780,
              }}>
                <b>Sin seguimiento</b> no significa que sigan abiertas: son rutas que
                desaparecieron de la lista de MELI cuando el monitor se apagó, así que no
                sabemos si cerraron.{pendientesCiegos > 0 ? ` Involucran ${pendientesCiegos} paquetes que figuraban pendientes.` : ""}{" "}
                Probablemente la mayoría cerró de madrugada. Desde hoy el monitor captura hasta
                las 23:59, así que este grupo debería reducirse.
              </div>
            )}

            {/* Detalle por ruta */}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--navy)", color: "#fff" }}>
                    {["Ruta", "SC", "Conductor", "Cargados", "Al cierre del día",
                      "Pendientes", "Desenlace", "Final", "NS ruta", "Arrancó", "Cerró"].map((h) => (
                      <th key={h} style={{
                        padding: "8px 9px", textAlign: "left", fontWeight: 600,
                        whiteSpace: "nowrap", fontSize: 11,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rutas.map((r) => {
                    const d = desenlace(r);
                    const nsAntes = pct(r.entregados_cierre, r.cargados);
                    const nsDespues = pct(r.entregados_final, r.cargados);
                    const mejoro = nsAntes !== "—" && nsDespues !== "—" && Number(nsDespues) > Number(nsAntes);
                    return (
                      <tr key={r.id_ruta} style={{ borderBottom: "1px solid var(--borde)" }}>
                        <td style={{ padding: "8px 9px", fontFamily: "monospace", fontSize: 11.5 }}>{r.id_ruta}</td>
                        <td style={{ padding: "8px 9px", fontWeight: 600 }}>{r.sc}</td>
                        <td style={{ padding: "8px 9px" }}>
                          {r.driver_name || "—"}
                          {r.vehicle_license && (
                            <span style={{ color: "var(--texto-tenue)", fontSize: 10.5 }}> · {r.vehicle_license}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center" }}>{r.cargados}</td>
                        <td style={{ padding: "8px 9px", textAlign: "center" }}>
                          {r.entregados_cierre}
                          {r.substatus_cierre && (
                            <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}> · {r.substatus_cierre}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center",
                          color: n0(r.pendientes_cierre) > 0 ? "#b45309" : "inherit" }}>
                          {r.pendientes_cierre}
                        </td>
                        <td style={{ padding: "8px 9px" }}>
                          <span title={r.desenlace === "sin_seguimiento"
                              ? "Desapareció de la lista de MELI al apagarse el monitor: no sabemos si cerró"
                              : undefined}
                            style={{
                              fontSize: 11, padding: "3px 8px", borderRadius: 20,
                              background: d.bg, border: `1px solid ${d.borde}`, color: d.color,
                              whiteSpace: "nowrap",
                              borderStyle: r.desenlace === "sin_seguimiento" ? "dashed" : "solid",
                            }}>{d.etiqueta}</span>
                          {n0(r.dias_arrastre) > 1 && (
                            <span style={{ fontSize: 10, color: "#b91c1c", marginLeft: 5 }}>
                              {r.dias_arrastre} días
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center", fontWeight: 600 }}>
                          {r.entregados_final}
                        </td>
                        <td style={{ padding: "8px 9px", whiteSpace: "nowrap" }}>
                          <span style={{ color: "var(--texto-tenue)" }}>{nsAntes}%</span>
                          {mejoro && <span style={{ color: "#15803d", fontWeight: 600 }}> → {nsDespues}%</span>}
                        </td>
                        <td style={{ padding: "8px 9px", fontSize: 11, color: "var(--texto-suave)", whiteSpace: "nowrap" }}>
                          {r.hora_arranque || "—"}
                        </td>
                        <td style={{ padding: "8px 9px", fontSize: 11, whiteSpace: "nowrap",
                          color: r.hora_cierre ? "#15803d" : "var(--texto-tenue)" }}>
                          {r.hora_cierre || (r.ya_cerro ? `visto ${r.hora_ultima_captura}` : "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Comparativo por SC */}
            {porSc.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                  Efecto en el NS por Service Center
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9" }}>
                        {["SC", "NS de cierre", "NS definitivo", "Diferencia",
                          "Rutas del día", "Con cierre tardío", "Entregas tardías"].map((h) => (
                          <th key={h} style={{
                            padding: "7px 12px", textAlign: "left", fontWeight: 600, fontSize: 11,
                            whiteSpace: "nowrap", borderBottom: "1px solid var(--borde)",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {porSc.map((x) => (
                        <tr key={x.sc} style={{ borderBottom: "1px solid var(--borde)" }}>
                          <td style={{ padding: "7px 12px", fontWeight: 600 }}>{x.sc}</td>
                          <td style={{ padding: "7px 12px" }}>{x.nsC != null ? `${x.nsC}%` : "—"}</td>
                          <td style={{ padding: "7px 12px", fontWeight: 600 }}>{x.nsD != null ? `${x.nsD}%` : "—"}</td>
                          <td style={{ padding: "7px 12px", fontWeight: 600,
                            color: x.dif > 0 ? "#15803d" : x.dif < 0 ? "#b91c1c" : "var(--texto-tenue)" }}>
                            {x.dif != null ? `${x.dif > 0 ? "+" : ""}${x.dif}` : "—"}
                          </td>
                          <td style={{ padding: "7px 12px", textAlign: "center" }}>{x.rutas}</td>
                          <td style={{ padding: "7px 12px", textAlign: "center" }}>{x.rutasTardias}</td>
                          <td style={{ padding: "7px 12px", textAlign: "center" }}>{x.tardias}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>
                  El <b>NS de cierre</b> es lo que se sabía con las capturas de ese día. El{" "}
                  <b>NS definitivo</b> atribuye cada ruta a su primer día operativo y cuenta su resultado
                  final, incluidas las entregas hechas la mañana siguiente. Ambos se conservan a propósito:
                  el primero es lo que se reportó y no cambia.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ══ SECCIÓN 2 · pendiente de definir ══ */}
      <div style={{
        background: "#fff", border: "1px dashed var(--borde)", borderRadius: 12,
        padding: 16, marginTop: 16, color: "var(--texto-tenue)", fontSize: 12.5,
      }}>
        2 · (pendiente de definir)
      </div>
    </div>
  );
}
