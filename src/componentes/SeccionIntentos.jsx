import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// ANOMALÍAS · SECCIÓN 2 · INTENTOS EN PAQUETES FALLIDOS
//
// QUÉ MUESTRA
//   Una fila por INTENTO de entrega fallido: paquete, ruta, SC, conductor,
//   placa, número de intento, hora exacta y motivo.
//
// DE DÓNDE SALE
//   Del historial de cada paquete en MELI, no del Case Center. Se comprobó que
//   el Case Center pierde intentos (el paquete 47640150663 tuvo 4 entregas
//   fallidas y solo 3 casos) y que sus horas son de creación del caso, no del
//   intento: 20:10 contra 17:09 reales. Para "la hora exacta del intento" esa
//   fuente no servía.
//
// LA COLUMNA QUE EVITA CONCLUSIONES FALSAS
//   "Δ min" es el tiempo desde el intento anterior. En los datos del 5 de agosto
//   los reintentos van de 455 minutos a 12. El de 455 es el conductor volviendo
//   de verdad; el de 12 es la misma visita registrada dos veces. Sin esa columna
//   los dos casos se ven idénticos y se le atribuye al conductor un reintento
//   que no hizo.
// ═══════════════════════════════════════════════════════════════════════════

const URL_TAREAS = import.meta.env.VITE_TAREAS_URL || "https://voz.bigticket.mx/tareas";

const n0 = (v) => (v == null ? 0 : Number(v));
const th = { padding: "7px 9px", textAlign: "left", fontWeight: 600, fontSize: 10.5, whiteSpace: "nowrap" };
const td = { padding: "7px 9px", fontSize: 11.5 };

function Chip({ children, tono }) {
  const c = {
    grave: { bg: "#fef2f2", bd: "#fca5a5", fg: "#b91c1c" },
    ok:    { bg: "#ecfdf5", bd: "#a7f3d0", fg: "#15803d" },
    tibio: { bg: "#fffbeb", bd: "#fde68a", fg: "#92400e" },
    gris:  { bg: "#f1f5f9", bd: "var(--borde)", fg: "var(--texto-suave)" },
  }[tono || "gris"];
  return (
    <span style={{
      fontSize: 10.5, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap",
      background: c.bg, border: `1px solid ${c.bd}`, color: c.fg,
    }}>{children}</span>
  );
}

export default function SeccionIntentos({ fecha }) {
  const { analista } = useAuth();
  const [filas, setFilas] = useState(null);
  const [resumen, setResumen] = useState(null);
  const [tarea, setTarea] = useState(null);
  const [error, setError] = useState(null);
  const [soloReintentos, setSoloReintentos] = useState(false);
  const canalRef = useRef(null);

  const cargar = useCallback(async () => {
    setError(null);
    const [d, r] = await Promise.all([
      sb.rpc("fn_intentos_fallidos_dia", { p_fecha: fecha }),
      sb.rpc("fn_intentos_resumen_dia", { p_fecha: fecha }),
    ]);
    if (d.error || r.error) {
      const m = (d.error || r.error).message;
      setError(/does not exist|no existe/i.test(m)
        ? "Faltan funciones en la base. Corre tareas_e_intentos.sql."
        : m);
      setFilas([]);
      return;
    }
    setFilas(d.data || []);
    setResumen(Array.isArray(r.data) ? r.data[0] : r.data);
  }, [fecha]);

  useEffect(() => { setFilas(null); cargar(); }, [cargar]);

  // Tarea activa + avance en vivo. Se escucha la tabla en vez de sondear el
  // VPS: así todas las analistas ven la misma corrida y sobrevive a un refresh.
  useEffect(() => {
    let vivo = true;
    const leer = async () => {
      const { data } = await sb.from("crm_tareas")
        .select("*").eq("tipo", "historial_paquetes")
        .order("iniciada_en", { ascending: false }).limit(1);
      if (vivo) setTarea(data?.[0] || null);
    };
    leer();
    canalRef.current = sb.channel("tareas-historial")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_tareas" }, (p) => {
        if (p.new?.tipo !== "historial_paquetes") return;
        setTarea(p.new);
        if (p.new.estado === "ok") cargar();   // al terminar, refrescar la tabla
      })
      .subscribe();
    return () => { vivo = false; if (canalRef.current) sb.removeChannel(canalRef.current); };
  }, [cargar]);

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
    } catch (e) {
      setError(e.message);
    }
  }

  const lista = filas || [];
  const visibles = soloReintentos ? lista.filter((f) => n0(f.total_intentos) > 1) : lista;

  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12,
      padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
            2 · Intentos en paquetes fallidos
          </div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", lineHeight: 1.55, maxWidth: 820 }}>
            Cada entrega fallida del {fecha} con su hora exacta y motivo, leída del historial
            del paquete en MELI. Un paquete puede tener varios intentos en el mismo día.
          </div>
        </div>
        <button className="btn-navy" onClick={lanzar} disabled={corriendo}
          style={{ padding: "9px 16px", fontSize: 12.5, whiteSpace: "nowrap" }}>
          {corriendo ? "Analizando…" : "▶ Analizar el día"}
        </button>
      </div>

      {corriendo && (
        <div style={{ fontSize: 12, background: "#eff6ff", border: "1px solid #bfdbfe",
          color: "#1e40af", borderRadius: 8, padding: "10px 12px", marginTop: 12, lineHeight: 1.5 }}>
          Consultando el historial de cada paquete fallido en MELI. Toma unos minutos y avanza
          aunque cierres esta pantalla.
        </div>
      )}

      {tarea && tarea.estado === "error" && (
        <div style={{ fontSize: 12, background: "#fef2f2", border: "1px solid #fca5a5",
          color: "#b91c1c", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          La última corrida falló: {tarea.error || "sin detalle"}
        </div>
      )}

      {tarea && tarea.estado === "ok" && tarea.resumen && (
        <div style={{ fontSize: 11, background: "#f8fafc", border: "1px solid var(--borde)",
          color: "var(--texto-suave)", borderRadius: 8, padding: "9px 12px", marginTop: 12,
          whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.45 }}>
          {tarea.resumen}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12.5, color: "#b91c1c", background: "#fef2f2",
          border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", marginTop: 12 }}>
          {error}
        </div>
      )}

      {resumen && n0(resumen.paquetes) > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))",
          gap: 9, margin: "14px 0" }}>
          {[
            ["Paquetes fallidos", resumen.paquetes, `${resumen.intentos} intentos`, "neutro"],
            ["Con más de un intento", resumen.con_reintento, "el conductor volvió", "neutro"],
            ["Reintentos reales", resumen.reintentos_reales, "más de 30 min", "bueno"],
            ["Reintentos dudosos", resumen.reintentos_dudosos, "menos de 30 min", "alerta"],
            ["Devueltos al vendedor", resumen.devueltos, `${resumen.rutas} rutas`, "grave"],
          ].map(([t, v, d, tono]) => (
            <div key={t} style={{
              background: tono === "grave" ? "#fef2f2" : tono === "alerta" ? "#fffbeb"
                        : tono === "bueno" ? "#ecfdf5" : "#fff",
              border: "1px solid var(--borde)", borderRadius: 10, padding: "11px 13px", minWidth: 0,
            }}>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginBottom: 3,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t}</div>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.05,
                color: tono === "grave" ? "#b91c1c" : tono === "alerta" ? "#92400e"
                     : tono === "bueno" ? "#15803d" : "var(--navy)" }}>{n0(v)}</div>
              <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2 }}>{d}</div>
            </div>
          ))}
        </div>
      )}

      {filas === null ? (
        <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "20px 0" }}>Cargando…</div>
      ) : lista.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--texto-suave)", background: "#f8fafc",
          border: "1px solid var(--borde)", borderRadius: 8, padding: "14px", marginTop: 12 }}>
          Sin datos de intentos para el {fecha}. Aprieta <b>Analizar el día</b> para consultar
          el historial de los paquetes fallidos en MELI.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <button onClick={() => setSoloReintentos(!soloReintentos)}
              style={{
                fontSize: 11, padding: "4px 11px", borderRadius: 20,
                border: `1px solid ${soloReintentos ? "var(--navy)" : "var(--borde)"}`,
                background: soloReintentos ? "#eef2f7" : "#fff",
              }}>
              Solo con más de un intento{soloReintentos ? " ✕" : ""}
            </button>
            <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
              {visibles.length} de {lista.length} intentos
            </span>
          </div>

          <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
                <tr style={{ background: "var(--navy)", color: "#fff" }}>
                  <th style={th}>SC</th>
                  <th style={th}>Ruta</th>
                  <th style={th}>Conductor</th>
                  <th style={th}>Placa</th>
                  <th style={th}>Paquete</th>
                  <th style={{ ...th, textAlign: "center" }}>Intento</th>
                  <th style={{ ...th, textAlign: "center" }}>Hora</th>
                  <th style={{ ...th, textAlign: "center" }}>Δ min</th>
                  <th style={th}>Motivo</th>
                  <th style={{ ...th, textAlign: "center" }}>Devuelto</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((f, i) => {
                  const multi = n0(f.total_intentos) > 1;
                  const dudoso = f.reintento_real === false;
                  return (
                    <tr key={`${f.shipment_id}-${f.intento}-${i}`} style={{
                      borderBottom: "1px solid var(--borde)",
                      background: dudoso ? "#fffbf5" : multi ? "#f7fbf8" : "transparent",
                    }}>
                      <td style={{ ...td, fontWeight: 600 }}>{f.sc}</td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{f.id_ruta ?? "—"}</td>
                      <td style={td}>{f.driver_name}</td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{f.vehicle_license}</td>
                      <td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{f.shipment_id}</td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {multi
                          ? <Chip tono={dudoso ? "tibio" : "ok"}>{f.intento} de {f.total_intentos}</Chip>
                          : <span style={{ color: "var(--texto-tenue)" }}>1 de 1</span>}
                      </td>
                      <td style={{ ...td, textAlign: "center", fontWeight: 600,
                        fontVariantNumeric: "tabular-nums" }}>{f.hora}</td>
                      <td style={{ ...td, textAlign: "center",
                        color: f.minutos_desde_anterior == null ? "var(--texto-tenue)"
                             : dudoso ? "#b45309" : "#15803d",
                        fontWeight: f.minutos_desde_anterior != null ? 600 : 400 }}>
                        {f.minutos_desde_anterior ?? "—"}
                      </td>
                      <td style={td}>{f.motivo}</td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {f.devuelto ? <Chip tono="grave">devuelto</Chip> : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 8,
            maxWidth: 780, lineHeight: 1.5 }}>
            <b>Δ min</b> es el tiempo desde el intento anterior del mismo paquete. Sobre 30 minutos
            se considera un reintento real; por debajo, la misma visita registrada dos veces.
            Las horas vienen del historial del paquete en MELI, no del Case Center.
          </div>
        </>
      )}
    </div>
  );
}
