import { useEffect, useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { diaMX } from "../shared/fechas.js";
import { ETIQUETAS_CASO } from "../shared/constantes.js";

// ═══════════════════════════════════════════════════════════════════════════
// BITÁCORA DEL DÍA
// 1) Eventos graves: se escriben SOLOS cuando una analista cierra un ticket
//    con etiqueta grave en Consultas (hora, SC, chofer, detalle).
// 2) Nivel de servicio por SC (entregados/cargados del día, sin line-haul)
//    vía fn_ns_por_sc, más la fila general.
// Al cierre del día, esta misma información alimenta el reporte por correo.
// ═══════════════════════════════════════════════════════════════════════════

const etiqueta = (id) => ETIQUETAS_CASO.find((e) => e.id === id) || { label: id, grave: false };
const horaMX = (ts) => new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

export default function Bitacora() {
  const [fechaSel, setFechaSel] = useState(diaMX());
  const [eventos, setEventos] = useState([]);
  const [ns, setNs] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  const cargar = useCallback(async (fecha) => {
    setError("");
    try {
      const [ev, nsr] = await Promise.all([
        sb.from("crm_bitacora_dia").select("*").eq("fecha", fecha).order("hora", { ascending: true }),
        sb.rpc("fn_ns_por_sc", { p_fecha: fecha }),
      ]);
      if (ev.error) throw ev.error;
      setEventos(ev.data || []);
      setNs(nsr.error ? [] : (nsr.data || []));
    } catch (e) {
      setError("No pudimos cargar la bitácora.");
    } finally { setCargando(false); }
  }, []);

  useEffect(() => { setCargando(true); cargar(fechaSel); }, [fechaSel, cargar]);

  // realtime: un cierre grave en Consultas aparece aquí al instante
  useEffect(() => {
    const canal = sb.channel("bitacora-dia")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crm_bitacora_dia" },
        () => cargar(fechaSel))
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [fechaSel, cargar]);

  const totEntregados = ns.reduce((a, r) => a + Number(r.entregados || 0), 0);
  const totCargados   = ns.reduce((a, r) => a + Number(r.total || 0), 0);
  const nsGeneral     = totCargados > 0 ? Math.round((1000 * totEntregados) / totCargados) / 10 : null;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Bitácora del día</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
            Eventos graves cerrados por la torre + nivel de servicio por SC
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="date" value={fechaSel} max={diaMX()}
            onChange={(e) => setFechaSel(e.target.value || diaMX())}
            style={{ fontSize: 12, padding: "6px 9px", border: "1px solid var(--borde)", borderRadius: 7 }} />
          {fechaSel !== diaMX() && (
            <button onClick={() => setFechaSel(diaMX())} style={{ fontSize: 12, padding: "6px 12px" }}>Hoy</button>
          )}
        </div>
      </div>

      {error && <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>{error}</div>}

      {/* ── Eventos graves ── */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>
          Eventos graves <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}>({eventos.length})</span>
        </div>
        {cargando ? (
          <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>
        ) : eventos.length === 0 ? (
          <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
            Sin eventos graves {fechaSel === diaMX() ? "hoy" : `el ${fechaSel}`}. 👌
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                <th style={{ padding: "8px 14px", fontWeight: 500 }}>Hora</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>SC</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Chofer</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Ticket</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Etiquetas</th>
                <th style={{ padding: "8px 14px", fontWeight: 500 }}>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {eventos.map((ev) => (
                <tr key={ev.id} style={{ borderTop: "1px solid var(--borde)", verticalAlign: "top" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 600, whiteSpace: "nowrap" }}>{horaMX(ev.hora)}</td>
                  <td style={{ padding: "9px 10px", fontWeight: 600 }}>{ev.sc || "—"}</td>
                  <td style={{ padding: "9px 10px" }}>{ev.chofer || ev.telefono || "—"}</td>
                  <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>{ev.codigo || ev.case_id || "—"}</td>
                  <td style={{ padding: "9px 10px" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {(Array.isArray(ev.etiquetas) ? ev.etiquetas : []).map((id) => {
                        const e = etiqueta(id);
                        return (
                          <span key={id} className="pill" style={{
                            background: e.grave ? "#FCEBEB" : "#f1f5f9",
                            color: e.grave ? "#791F1F" : "#475569" }}>{e.label}</span>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ padding: "9px 14px", fontSize: 12.5, color: "var(--texto)", maxWidth: 420 }}>{ev.detalle || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Nivel de servicio por SC ── */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>
          Nivel de servicio por SC
          <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}> (entregados / cargados del día, reparto)</span>
        </div>
        {ns.length === 0 ? (
          <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
            Sin capturas de rutas para esta fecha.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                <th style={{ padding: "8px 14px", fontWeight: 500 }}>SC</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Entregados</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Cargados</th>
                <th style={{ padding: "8px 14px", fontWeight: 500 }}>NS</th>
              </tr>
            </thead>
            <tbody>
              {ns.map((r) => (
                <tr key={r.sc} style={{ borderTop: "1px solid var(--borde)" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 600 }}>{r.sc || "—"}</td>
                  <td style={{ padding: "9px 10px" }}>{Number(r.entregados).toLocaleString("es-MX")}</td>
                  <td style={{ padding: "9px 10px" }}>{Number(r.total).toLocaleString("es-MX")}</td>
                  <td style={{ padding: "9px 14px", fontWeight: 600, color: r.ns >= 95 ? "#16a34a" : r.ns >= 85 ? "#b45309" : "#b91c1c" }}>
                    {r.ns != null ? `${r.ns}%` : "—"}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "2px solid var(--borde)", background: "var(--fondo)" }}>
                <td style={{ padding: "9px 14px", fontWeight: 700 }}>SC General</td>
                <td style={{ padding: "9px 10px", fontWeight: 600 }}>{totEntregados.toLocaleString("es-MX")}</td>
                <td style={{ padding: "9px 10px", fontWeight: 600 }}>{totCargados.toLocaleString("es-MX")}</td>
                <td style={{ padding: "9px 14px", fontWeight: 700, color: nsGeneral >= 95 ? "#16a34a" : nsGeneral >= 85 ? "#b45309" : "#b91c1c" }}>
                  {nsGeneral != null ? `${nsGeneral}%` : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
