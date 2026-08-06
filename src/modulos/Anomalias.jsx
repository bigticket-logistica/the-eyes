import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { diaMX } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// ANOMALÍAS · lo que distorsiona las cifras del día
//
// SECCIÓN 1 · CIERRE TARDÍO
//   Hay rutas que no alcanzan a cerrar y terminan la mañana siguiente. Antes
//   eso no se podía medir: el monitor se apagaba y esas rutas desaparecían de
//   la lista de MELI, así que su resultado quedaba en el aire.
//
//   Ahora el ciclo es:
//     00:10 · se congela la FOTO del día (crm_cierre_dia_rutas, no se toca más)
//     08:00 · la RECONCILIACIÓN consulta a MELI el detalle de cada ruta abierta
//   Esta pantalla compara las dos cosas: lo que se reportó contra lo que pasó.
//
//   Se lee de la tabla, no se recalcula. Antes se derivaba del historial de
//   capturas y cada cambio en el monitor movía los números del pasado.
// ═══════════════════════════════════════════════════════════════════════════

function ayerMX() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return diaMX(d);
}

const n0 = (v) => (v == null ? 0 : Number(v));

// El desenlace lo decide y lo guarda la base (fn_reconciliar_ruta).
// cerro_con_fallidos es el caso grave: la ruta cerró convirtiendo pendientes en
// no entregados. Ese es el que la torre nunca veía.
const DESENLACES = {
  cerro_tarde_con_entregas: { etiqueta: "Cerró con entregas",  bg: "#ecfdf5", borde: "#a7f3d0", color: "#15803d" },
  cerro_tarde_sin_entregas: { etiqueta: "Cerró sin cambios",   bg: "#f1f5f9", borde: "var(--borde)", color: "var(--texto-suave)" },
  cerro_con_fallidos:       { etiqueta: "Cerró con fallidos",  bg: "#fef2f2", borde: "#fca5a5", color: "#b91c1c" },
  sigue_abierta:            { etiqueta: "Sigue abierta",       bg: "#fffbeb", borde: "#fde68a", color: "#92400e" },
  no_encontrada:            { etiqueta: "No encontrada",       bg: "#f8fafc", borde: "var(--borde)", color: "var(--texto-tenue)" },
  pendiente_reconciliar:    { etiqueta: "Por reconciliar",     bg: "#f8fafc", borde: "var(--borde)", color: "var(--texto-tenue)" },
};

function Tarjeta({ titulo, valor, detalle, tono, onClick, activa }) {
  const c = {
    alerta: { bg: "#fffbeb", borde: "#fde68a", txt: "#92400e" },
    grave:  { bg: "#fef2f2", borde: "#fca5a5", txt: "#b91c1c" },
    bueno:  { bg: "#ecfdf5", borde: "#a7f3d0", txt: "#15803d" },
    neutro: { bg: "#fff",    borde: "var(--borde)", txt: "var(--navy)" },
  }[tono || "neutro"];
  const clic = typeof onClick === "function";
  return (
    <div onClick={onClick}
      title={clic ? (activa ? "Quitar filtro" : "Filtrar la tabla") : undefined}
      style={{
        background: c.bg,
        border: `${activa ? 2 : 1}px solid ${activa ? "var(--navy)" : c.borde}`,
        borderRadius: 10, padding: activa ? "10px 12px" : "11px 13px",
        cursor: clic ? "pointer" : "default", minWidth: 0,
        boxShadow: activa ? "0 2px 8px rgba(26,58,107,.15)" : "none",
      }}>
      <div style={{
        fontSize: 10.5, color: "var(--texto-suave)", marginBottom: 3,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {titulo}{activa ? " ✕" : ""}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.txt, lineHeight: 1.05 }}>{valor}</div>
      {detalle && (
        <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2, lineHeight: 1.3 }}>
          {detalle}
        </div>
      )}
    </div>
  );
}

const pctTxt = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);

export default function Anomalias() {
  const [fecha, setFecha] = useState(ayerMX());
  const [filtro, setFiltro] = useState(null);
  const [rutas, setRutas] = useState(null);
  const [ns, setNs] = useState([]);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setRutas(null); setError(null);
    const [a, b] = await Promise.all([
      sb.rpc("fn_anomalias_cierre", { p_fecha: fecha }),
      sb.rpc("fn_ns_dia_congelado", { p_fecha: fecha }),
    ]);
    const err = a.error || b.error;
    if (err) {
      setError(/does not exist|no existe/i.test(err.message)
        ? "Faltan las funciones de cierre en la base. Corre cierre_dia_rutas.sql."
        : err.message);
      setRutas([]);
      return;
    }
    setRutas(a.data || []);
    setNs(b.data || []);
  }, [fecha]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { setFiltro(null); }, [fecha]);

  const lista = rutas || [];
  const cuenta = (d) => lista.filter((r) => r.desenlace === d).length;
  const total = lista.length;
  const conEntregas = cuenta("cerro_tarde_con_entregas");
  const conFallidos = cuenta("cerro_con_fallidos");
  const abiertas = cuenta("sigue_abierta");
  const porReconciliar = cuenta("pendiente_reconciliar");
  const sinCambios = cuenta("cerro_tarde_sin_entregas");
  const recuperadas = lista.reduce((s, r) => s + Math.max(0, n0(r.delta_entregas)), 0);
  const nuevosFallidos = lista.reduce(
    (s, r) => s + Math.max(0, n0(r.fallidos_final) - n0(r.fallidos_cierre)), 0);

  // NS del día completo, de la foto y del resultado real
  const sum = (arr, k) => arr.reduce((s, x) => s + n0(x[k]), 0);
  const nsCierre = sum(ns, "cargados") > 0
    ? (100 * sum(ns, "entregados") / sum(ns, "cargados")) : null;
  const nsReal = sum(ns, "cargados") > 0
    ? (100 * sum(ns, "entregados_final") / sum(ns, "cargados")) : null;
  const delta = (nsCierre != null && nsReal != null) ? +(nsReal - nsCierre).toFixed(1) : null;

  const visibles = filtro ? lista.filter((r) => r.desenlace === filtro) : lista;

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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>1 · Rutas de cierre tardío</div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", lineHeight: 1.55, maxWidth: 860 }}>
          Rutas que <b>no cerraron el {fecha}</b> y terminaron después. La foto del cierre se congela
          a las 00:10 y a las 08:00 se consulta a MELI qué pasó con cada una. Las tarjetas filtran la tabla.
        </div>

        {error && (
          <div style={{
            fontSize: 12.5, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fca5a5",
            borderRadius: 8, padding: "10px 12px", margin: "12px 0",
          }}>{error}</div>
        )}

        {rutas === null ? (
          <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "20px 0" }}>Cargando…</div>
        ) : total === 0 && !error ? (
          <div style={{
            fontSize: 12.5, color: "#15803d", background: "#ecfdf5", border: "1px solid #a7f3d0",
            borderRadius: 8, padding: "12px 14px", marginTop: 12,
          }}>
            ✓ Todas las rutas del {fecha} cerraron dentro de su propio día.
          </div>
        ) : (
          <>
            {/* Seis tarjetas en UNA sola línea: grid de columnas iguales, sin wrap */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
              gap: 9, margin: "14px 0",
            }}>
              <Tarjeta titulo="Quedaron abiertas" valor={total} detalle="ver todas"
                onClick={() => setFiltro(null)} activa={filtro === null} />
              <Tarjeta titulo="Cerró con entregas" valor={conEntregas}
                detalle={recuperadas > 0 ? `+${recuperadas} entregas` : "—"} tono="bueno"
                onClick={() => setFiltro(filtro === "cerro_tarde_con_entregas" ? null : "cerro_tarde_con_entregas")}
                activa={filtro === "cerro_tarde_con_entregas"} />
              <Tarjeta titulo="Cerró con fallidos" valor={conFallidos}
                detalle={nuevosFallidos > 0 ? `+${nuevosFallidos} fallidos` : "—"}
                tono={conFallidos > 0 ? "grave" : "neutro"}
                onClick={() => setFiltro(filtro === "cerro_con_fallidos" ? null : "cerro_con_fallidos")}
                activa={filtro === "cerro_con_fallidos"} />
              <Tarjeta titulo="Sigue abierta" valor={abiertas}
                detalle={porReconciliar > 0 ? `${porReconciliar} sin reconciliar` : "requiere gestión"}
                tono={abiertas > 0 ? "alerta" : "neutro"}
                onClick={() => setFiltro(filtro === "sigue_abierta" ? null : "sigue_abierta")}
                activa={filtro === "sigue_abierta"} />
              <Tarjeta titulo="NS de cierre" valor={pctTxt(nsCierre)} detalle="lo que se reportó" />
              <Tarjeta titulo="NS real" valor={pctTxt(nsReal)}
                detalle={delta ? `${delta > 0 ? "+" : ""}${delta} pts` : "sin diferencia"}
                tono={delta > 0 ? "bueno" : "neutro"} />
            </div>

            {/* Filtros secundarios, para no sumar más tarjetas a la línea */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
              {[["cerro_tarde_sin_entregas", `Sin cambios (${sinCambios})`],
                ["pendiente_reconciliar", `Por reconciliar (${porReconciliar})`]]
                .filter(([k]) => (k === "cerro_tarde_sin_entregas" ? sinCambios : porReconciliar) > 0)
                .map(([k, txt]) => (
                  <button key={k} onClick={() => setFiltro(filtro === k ? null : k)}
                    style={{
                      fontSize: 11, padding: "4px 10px", borderRadius: 20,
                      border: `1px solid ${filtro === k ? "var(--navy)" : "var(--borde)"}`,
                      background: filtro === k ? "#eef2f7" : "#fff",
                    }}>{txt}{filtro === k ? " ✕" : ""}</button>
                ))}
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--navy)", color: "#fff" }}>
                    {["Ruta", "SC", "Conductor", "Cargados", "Al cierre", "NS cierre",
                      "Final", "NS real", "Δ NS", "Desenlace", "Arrancó", "Cerró"].map((h) => (
                      <th key={h} style={{
                        padding: "8px 9px", textAlign: "left", fontWeight: 600,
                        fontSize: 10.5, whiteSpace: "nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((r) => {
                    const d = DESENLACES[r.desenlace] || DESENLACES.pendiente_reconciliar;
                    const dNs = r.delta_ns == null ? null : Number(r.delta_ns);
                    return (
                      <tr key={r.id_ruta} style={{ borderBottom: "1px solid var(--borde)" }}>
                        <td style={{ padding: "8px 9px", fontFamily: "monospace", fontSize: 11 }}>{r.id_ruta}</td>
                        <td style={{ padding: "8px 9px", fontWeight: 600 }}>{r.sc}</td>
                        <td style={{ padding: "8px 9px" }}>
                          {r.driver_name || "—"}
                          {r.vehicle_license && (
                            <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}> · {r.vehicle_license}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center" }}>{r.cargados}</td>
                        <td style={{ padding: "8px 9px", textAlign: "center" }}>
                          {r.entregados_cierre}
                          {n0(r.fallidos_cierre) > 0 && (
                            <span style={{ color: "#b45309", fontSize: 10 }}> · {r.fallidos_cierre} fall.</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center", color: "var(--texto-suave)" }}>
                          {pctTxt(r.ns_cierre)}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center", fontWeight: 600 }}>
                          {r.entregados_final ?? "—"}
                          {n0(r.fallidos_final) > n0(r.fallidos_cierre) && (
                            <span style={{ color: "#b91c1c", fontSize: 10 }}>
                              {" "}· {r.fallidos_final} fall.
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "8px 9px", textAlign: "center", fontWeight: 600 }}>
                          {pctTxt(r.ns_final)}
                        </td>
                        <td style={{
                          padding: "8px 9px", textAlign: "center", fontWeight: 600,
                          color: dNs > 0 ? "#15803d" : dNs < 0 ? "#b91c1c" : "var(--texto-tenue)",
                        }}>
                          {dNs == null ? "—" : dNs === 0 ? "0" : `${dNs > 0 ? "+" : ""}${dNs.toFixed(1)}`}
                        </td>
                        <td style={{ padding: "8px 9px" }}>
                          <span style={{
                            fontSize: 10.5, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap",
                            background: d.bg, border: `1px solid ${d.borde}`, color: d.color,
                          }}>{d.etiqueta}</span>
                        </td>
                        <td style={{ padding: "8px 9px", fontSize: 10.5, color: "var(--texto-suave)", whiteSpace: "nowrap" }}>
                          {r.hora_arranque || "—"}
                        </td>
                        <td style={{
                          padding: "8px 9px", fontSize: 10.5, whiteSpace: "nowrap",
                          color: r.hora_cierre_real ? "#15803d" : "var(--texto-tenue)",
                        }}>
                          {r.hora_cierre_real || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {ns.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                  NS del día por Service Center
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9" }}>
                        {["SC", "Rutas", "Cargados", "NS de cierre", "NS real", "Diferencia"].map((h) => (
                          <th key={h} style={{
                            padding: "7px 13px", textAlign: "left", fontWeight: 600, fontSize: 10.5,
                            whiteSpace: "nowrap", borderBottom: "1px solid var(--borde)",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ns.map((x) => {
                        const dif = (x.ns != null && x.ns_final != null)
                          ? +(Number(x.ns_final) - Number(x.ns)).toFixed(1) : null;
                        return (
                          <tr key={x.sc} style={{ borderBottom: "1px solid var(--borde)" }}>
                            <td style={{ padding: "7px 13px", fontWeight: 600 }}>{x.sc}</td>
                            <td style={{ padding: "7px 13px", textAlign: "center" }}>{x.rutas}</td>
                            <td style={{ padding: "7px 13px", textAlign: "center" }}>{x.cargados}</td>
                            <td style={{ padding: "7px 13px" }}>{pctTxt(x.ns)}</td>
                            <td style={{ padding: "7px 13px", fontWeight: 600 }}>{pctTxt(x.ns_final)}</td>
                            <td style={{
                              padding: "7px 13px", fontWeight: 600,
                              color: dif > 0 ? "#15803d" : dif < 0 ? "#b91c1c" : "var(--texto-tenue)",
                            }}>
                              {dif == null ? "—" : dif === 0 ? "0" : `${dif > 0 ? "+" : ""}${dif}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{
        background: "#fff", border: "1px dashed var(--borde)", borderRadius: 12,
        padding: 16, marginTop: 16, color: "var(--texto-tenue)", fontSize: 12.5,
      }}>
        2 · (pendiente de definir)
      </div>
    </div>
  );
}
