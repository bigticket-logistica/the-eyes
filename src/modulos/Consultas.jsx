import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta, conversacionPorTelefono, ventanaAbierta, enviarMensaje } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";

const ABIERTOS = ["NEW", "OPEN", "ON_HOLD", "CHECKING"];

function Burbuja({ m }) {
  const saliente = m.direccion === "saliente";
  const esIA = m.emisor === "ia";
  const bg = saliente ? (esIA ? "#EEF2FF" : "var(--navy)") : "#fff";
  const color = saliente && !esIA ? "#fff" : "var(--texto)";
  return (
    <div style={{ display: "flex", justifyContent: saliente ? "flex-end" : "flex-start" }}>
      <div style={{ maxWidth: "78%", background: bg, color,
        border: saliente && !esIA ? "none" : "1px solid var(--borde)", borderRadius: 12, padding: "8px 12px" }}>
        {saliente && <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{esIA ? "Asistente IA" : "Analista"}</div>}
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.tipo_contenido === "texto" ? m.texto : `[${m.tipo_contenido}]${m.texto ? " " + m.texto : ""}`}
        </div>
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3, textAlign: "right" }}>
          {fechaHora(m.creado_en)}{saliente && m.estado_entrega ? ` · ${m.estado_entrega}` : ""}
        </div>
      </div>
    </div>
  );
}

// separador verde de ticket cerrado
function LineaCierre({ codigo }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
      <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.45 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: "#15803d", whiteSpace: "nowrap" }}>✓ {codigo} resuelto</span>
      <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.45 }} />
    </div>
  );
}

export default function Consultas() {
  const { analista } = useAuth();
  const { marcarVistos } = useAlertas();
  const [convs, setConvs] = useState([]);
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [casos, setCasos] = useState({});          // {case_id: caso} de esta conversación
  const [ticketAbierto, setTicketAbierto] = useState(null);
  const [haySinCaso, setHaySinCaso] = useState(false);
  const [texto, setTexto] = useState("");
  const [conversacion, setConversacion] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [accion, setAccion] = useState(false);
  const [error, setError] = useState(null);
  const leidosRef = useRef(new Set());
  const finRef = useRef(null);
  const selRef = useRef(null);
  selRef.current = sel;

  const aplicarLeidos = useCallback((lista) =>
    lista.map((c) => leidosRef.current.has(c.id) ? { ...c, no_leidos: 0 } : c), []);

  const cargarConvs = useCallback(async () => {
    try { setConvs(aplicarLeidos(await listarConversaciones())); }
    catch (e) { setError(e.message); }
  }, [aplicarLeidos]);

  // carga el hilo de una conversación: mensajes + casos + estado
  const cargarHilo = useCallback(async (conv) => {
    const msgs = await mensajesDeConversacion(conv.id);
    setMensajes(msgs);
    const caseIds = [...new Set(msgs.map((m) => m.case_id).filter(Boolean))];
    const mapa = {};
    let abierto = null;
    if (caseIds.length) {
      const { data: cs } = await sb.from("crm_inc_casos").select("*").in("case_id", caseIds);
      for (const c of (cs || [])) {
        mapa[c.case_id] = c;
        if (ABIERTOS.includes(c.estado_id)) abierto = c;
      }
    }
    setCasos(mapa);
    setTicketAbierto(abierto);
    setHaySinCaso(msgs.some((m) => !m.case_id && m.direccion === "entrante"));
    const cv = await conversacionPorTelefono(conv.telefono);
    setConversacion(cv);
  }, []);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);
  useEffect(() => { marcarVistos(); }, [marcarVistos]);

  // Realtime lista de conversaciones
  useEffect(() => {
    const canal = sb.channel("consultas-lista")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_conversaciones" }, cargarConvs)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarConvs]);

  // Realtime mensajes de la conversación abierta (refresca el hilo al instante)
  useEffect(() => {
    if (!sel) return;
    const canal = sb.channel(`consulta-hilo-${sel.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crm_inc_mensajes", filter: `conversacion_id=eq.${sel.id}` },
        () => { if (selRef.current) cargarHilo(selRef.current); })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [sel, cargarHilo]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mensajes.length]);

  async function abrirConv(conv) {
    setSel(conv); setCargando(true); setError(null);
    setMensajes([]); setCasos({}); setTicketAbierto(null); setHaySinCaso(false);
    try {
      // marcar leída
      leidosRef.current.add(conv.id);
      setConvs((prev) => prev.map((c) => c.id === conv.id ? { ...c, no_leidos: 0 } : c));
      sb.from("crm_inc_conversaciones").update({ no_leidos: 0 }).eq("id", conv.id).then(() => {});
      await cargarHilo(conv);
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }

  // tomar: crea el ticket (BT-) y queda abierto en el mismo hilo, sin salir
  async function tomar() {
    if (!sel || accion) return;
    setAccion(true); setError(null);
    try {
      await crearCasoConsulta(sel.id, analista?.id);
      await cargarHilo(sel);     // recarga el hilo: ahora hay ticket abierto
      await cargarConvs();
    } catch (e) { setError(e.message); }
    finally { setAccion(false); }
  }

  // cerrar el ticket abierto: genera la línea verde, el hilo sigue
  async function cerrar() {
    if (!ticketAbierto || accion) return;
    setAccion(true); setError(null);
    try {
      const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: ticketAbierto.id, p_estado: "CLOSED" });
      if (error) { setError("No se pudo cerrar: " + error.message); return; }
      await cargarHilo(sel);
      await cargarConvs();
    } catch (e) { setError(e.message); }
    finally { setAccion(false); }
  }

  async function enviar() {
    const t = texto.trim();
    if (!t || accion || !ticketAbierto) return;
    setAccion(true); setError(null);
    try {
      await enviarMensaje({ telefono: sel.telefono, texto: t, caseId: ticketAbierto.case_id, emisorId: analista?.id });
      setTexto("");
      await cargarHilo(sel);
    } catch (e) { setError(e.message || "No se pudo enviar"); }
    finally { setAccion(false); }
  }

  const ventana = ventanaAbierta(conversacion);

  // construye el hilo intercalando líneas verdes al cambiar de ticket cerrado
  function renderHilo() {
    const out = [];
    for (let i = 0; i < mensajes.length; i++) {
      const m = mensajes[i];
      out.push(<Burbuja key={m.id} m={m} />);
      const cid = m.case_id;
      const sig = mensajes[i + 1];
      const cambiaTicket = !sig || sig.case_id !== cid;
      // si este mensaje pertenece a un ticket cerrado y el siguiente es de otro (o no hay), línea verde
      if (cid && cambiaTicket && casos[cid] && !ABIERTOS.includes(casos[cid].estado_id)) {
        out.push(<LineaCierre key={`cierre-${cid}`} codigo={casos[cid].codigo || "#" + cid} />);
      }
    }
    return out;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.9fr) 1.6fr", height: "100%" }}>
      {/* lista de conversaciones */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--borde)", fontSize: 13, fontWeight: 600,
          position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>Consultas en ruta</div>
        {convs.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>Sin conversaciones todavía</div>
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
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.ultimo_mensaje_texto || "—"}</div>
              <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2 }}>{hace(c.ultimo_mensaje_en)}</div>
            </div>
          );
        })}
      </div>

      {/* panel derecho: hilo único del conductor */}
      {!sel ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>
          Selecciona una conversación
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
          {/* header */}
          <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)", display: "flex",
            alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{sel.conductor_nombre || sel.telefono}</div>
              <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
                {sel.telefono}{ticketAbierto ? ` · ${ticketAbierto.codigo || "#" + ticketAbierto.case_id} abierto` : " · sin ticket abierto"}
              </div>
            </div>
            {ticketAbierto && (
              <span className="pill" style={{ background: "#e0e7ff", color: "var(--navy)" }}>
                {ticketAbierto.codigo || "#" + ticketAbierto.case_id}
              </span>
            )}
          </div>

          {/* hilo */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)",
            display: "flex", flexDirection: "column", gap: 8 }}>
            {cargando ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
            ) : mensajes.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Sin mensajes</div>
            ) : renderHilo()}
            <div ref={finRef} />
          </div>

          {/* barra inferior según estado */}
          <div style={{ borderTop: "1px solid var(--borde)" }}>
            {error && <div style={{ padding: "6px 16px", fontSize: 12, color: "#bb4444", background: "#fff5f5" }}>{error}</div>}
            {ticketAbierto ? (
              <>
                {!ventana && (
                  <div style={{ padding: "6px 16px", fontSize: 11, color: "#92722a", background: "#fffbeb" }}>
                    Ventana de 24h cerrada. El conductor debe escribir primero para responder texto libre.
                  </div>
                )}
                <div style={{ padding: "11px 16px", display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={texto} onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
                    placeholder="Escribe al conductor…" disabled={accion} style={{ flex: 1 }} />
                  <button className="btn-navy" onClick={enviar} disabled={accion || !texto.trim()}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>{accion ? "…" : "Enviar"}</button>
                  <button className="btn-naranja" onClick={cerrar} disabled={accion}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>Cerrar ticket</button>
                </div>
              </>
            ) : haySinCaso ? (
              <div style={{ padding: "11px 16px" }}>
                <button className="btn-navy" onClick={tomar} disabled={accion} style={{ width: "100%", padding: "10px" }}>
                  {accion ? "Creando ticket…" : "Tomar consulta y crear ticket"}
                </button>
                <div style={{ fontSize: 11, color: "var(--texto-tenue)", textAlign: "center", marginTop: 6 }}>
                  Hay mensajes nuevos sin ticket. Se crea un BT- y empieza el cronómetro.
                </div>
              </div>
            ) : (
              <div style={{ padding: "14px 16px", fontSize: 12, color: "var(--texto-suave)", textAlign: "center" }}>
                Sin consultas pendientes. Si el conductor escribe, podrás tomar un ticket nuevo.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
