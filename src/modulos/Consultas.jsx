import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";
import HiloTicket from "../componentes/HiloTicket.jsx";

const ABIERTOS = ["NEW", "OPEN", "ON_HOLD", "CHECKING"];

function Burbuja({ m }) {
  const saliente = m.direccion === "saliente";
  return (
    <div style={{ display: "flex", justifyContent: saliente ? "flex-end" : "flex-start" }}>
      <div style={{ maxWidth: "78%", background: saliente ? "var(--navy)" : "#fff",
        color: saliente ? "#fff" : "var(--texto)", border: saliente ? "none" : "1px solid var(--borde)",
        borderRadius: 12, padding: "8px 12px" }}>
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.tipo_contenido === "texto" ? m.texto : `[${m.tipo_contenido}]`}
        </div>
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3, textAlign: "right" }}>{fechaHora(m.creado_en)}</div>
      </div>
    </div>
  );
}

export default function Consultas() {
  const { analista } = useAuth();
  const { marcarVistos } = useAlertas();
  const [convs, setConvs] = useState([]);
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [casoAbierto, setCasoAbierto] = useState(null);   // caso ABIERTO de la conversación
  const [casoCerrado, setCasoCerrado] = useState(null);   // último caso CERRADO (para mostrar su hilo)
  const [haySinCaso, setHaySinCaso] = useState(false);    // hay mensajes nuevos sin caso
  const [cargando, setCargando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState(null);
  const leidosRef = useRef(new Set());  // ids de conversaciones ya leídas (sobrevive recargas)

  // aplica el "ya leído" local sobre la lista que llega de la base
  const aplicarLeidos = useCallback((lista) => {
    return lista.map((c) => leidosRef.current.has(c.id) ? { ...c, no_leidos: 0 } : c);
  }, []);

  const cargarConvs = useCallback(async () => {
    try {
      const lista = await listarConversaciones();
      setConvs(aplicarLeidos(lista));
    } catch (e) { setError(e.message); }
  }, [aplicarLeidos]);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);
  useEffect(() => { marcarVistos(); }, [marcarVistos]);

  // Realtime: refresca la lista, respetando los ya leídos
  useEffect(() => {
    const canal = sb.channel("consultas-lista")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_conversaciones" }, cargarConvs)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarConvs]);

  const abrirConv = useCallback(async (conv) => {
    setSel(conv); setCargando(true); setError(null);
    setCasoAbierto(null); setCasoCerrado(null); setHaySinCaso(false);
    try {
      const msgs = await mensajesDeConversacion(conv.id);
      setMensajes(msgs);

      // marcar leída: badge a 0 (local + persistente + base)
      leidosRef.current.add(conv.id);
      setConvs((prev) => prev.map((c) => c.id === conv.id ? { ...c, no_leidos: 0 } : c));
      const { error: upErr } = await sb.from("crm_inc_conversaciones")
        .update({ no_leidos: 0 }).eq("id", conv.id);
      if (upErr) console.error("no_leidos update:", upErr.message);

      // ver qué casos tiene esta conversación (abierto y/o cerrado)
      const caseIds = [...new Set(msgs.map((m) => m.case_id).filter(Boolean))];
      let abierto = null, cerrado = null;
      if (caseIds.length) {
        const { data: casos } = await sb.from("crm_inc_casos")
          .select("*").in("case_id", caseIds).order("case_id", { ascending: false });
        for (const c of (casos || [])) {
          if (!abierto && ABIERTOS.includes(c.estado_id)) abierto = c;
          if (!cerrado && !ABIERTOS.includes(c.estado_id)) cerrado = c;
        }
      }
      setCasoAbierto(abierto);
      setCasoCerrado(cerrado);
      // ¿hay mensajes entrantes SIN caso? (nuevos, tras cerrar) → permitir crear caso
      setHaySinCaso(msgs.some((m) => !m.case_id && m.direccion === "entrante"));
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }, []);

  async function tomarConsulta() {
    if (!sel || creando) return;
    setCreando(true); setError(null);
    try {
      const caseId = await crearCasoConsulta(sel.id, analista?.id);
      const { data } = await sb.from("crm_inc_casos").select("*").eq("case_id", caseId).maybeSingle();
      setCasoAbierto(data); setHaySinCaso(false);
      await cargarConvs();
    } catch (e) { setError(e.message); }
    finally { setCreando(false); }
  }

  async function resolverCaso(caso) {
    if (!caso) return;
    try {
      const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: caso.id, p_estado: "CLOSED" });
      if (error) { setError("No se pudo cerrar: " + error.message); return; }
      await cargarConvs();
      if (sel) await abrirConv(sel);
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.9fr) 1.4fr", height: "100%" }}>
      {/* lista de conversaciones */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--borde)", fontSize: 13, fontWeight: 600,
          position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          Consultas en ruta
        </div>
        {convs.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>
            Sin conversaciones todavía
          </div>
        )}
        {convs.map((c) => {
          const activo = sel?.id === c.id;
          return (
            <div key={c.id} onClick={() => abrirConv(c)}
              style={{ padding: "10px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                background: activo ? "var(--naranja-suave)" : "#fff",
                borderLeft: `3px solid ${activo ? "var(--naranja)" : "transparent"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{c.conductor_nombre || c.telefono}</span>
                {c.no_leidos > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 600, background: "var(--naranja)",
                    color: "#fff", borderRadius: 10, padding: "1px 7px" }}>{c.no_leidos}</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.ultimo_mensaje_texto || "—"}
              </div>
              <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2 }}>{hace(c.ultimo_mensaje_en)}</div>
            </div>
          );
        })}
      </div>

      {/* panel derecho */}
      {!sel ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>
          Selecciona una conversación
        </div>
      ) : casoAbierto ? (
        // hay un caso abierto: hilo normal con todas sus funciones
        <HiloTicket caso={casoAbierto} analistaId={analista?.id}
          onTomar={() => {}} onResolver={resolverCaso} />
      ) : (
        // no hay caso abierto: mostrar (si existe) el último caso cerrado con su línea verde,
        // y abajo, si hay mensajes nuevos sin caso, el botón para crear caso nuevo.
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{sel.conductor_nombre || sel.telefono}</div>
            <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>{sel.telefono}</div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)",
            display: "flex", flexDirection: "column", gap: 8 }}>
            {cargando ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
            ) : mensajes.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Sin mensajes</div>
            ) : (
              mensajes.map((m, i) => {
                // línea verde separadora: justo después del último mensaje del caso cerrado
                const esUltimoDelCerrado = casoCerrado && m.case_id === casoCerrado.case_id &&
                  (i === mensajes.length - 1 || mensajes[i + 1]?.case_id !== casoCerrado.case_id);
                return (
                  <div key={m.id}>
                    <Burbuja m={m} />
                    {esUltimoDelCerrado && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0 4px" }}>
                        <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.5 }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#15803d" }}>
                          ✓ {casoCerrado.codigo || "#" + casoCerrado.case_id} resuelto
                        </span>
                        <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.5 }} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--borde)", padding: "11px 16px" }}>
            {error && <div style={{ fontSize: 12, color: "#bb4444", marginBottom: 8 }}>{error}</div>}
            {haySinCaso ? (
              <>
                <button className="btn-navy" onClick={tomarConsulta} disabled={creando}
                  style={{ width: "100%", padding: "10px" }}>
                  {creando ? "Creando caso…" : "Tomar consulta y crear caso"}
                </button>
                <div style={{ fontSize: 11, color: "var(--texto-tenue)", textAlign: "center", marginTop: 6 }}>
                  Hay mensajes nuevos sin caso. Se generará un caso BT- y empieza el cronómetro.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--texto-suave)", textAlign: "center" }}>
                Sin consultas nuevas pendientes en esta conversación.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
