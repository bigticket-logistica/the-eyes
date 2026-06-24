import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta, ventanaAbierta } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";
import HiloTicket from "../componentes/HiloTicket.jsx";
import { fechaHora } from "../shared/fechas.js";

// Burbuja simple para el hilo de conversación (sin caso aún)
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
  const [sel, setSel] = useState(null);          // conversación seleccionada
  const [mensajes, setMensajes] = useState([]);
  const [casoAbierto, setCasoAbierto] = useState(null); // caso si la conversación ya tiene uno
  const [cargando, setCargando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState(null);

  const cargarConvs = useCallback(async () => {
    try { setConvs(await listarConversaciones()); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);

  // al entrar a esta pestaña, marcar los mensajes como vistos (resetea el badge)
  useEffect(() => { marcarVistos(); }, [marcarVistos]);

  // Realtime: nuevas conversaciones / mensajes refrescan la lista
  useEffect(() => {
    const canal = sb.channel("consultas-lista")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_conversaciones" }, cargarConvs)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarConvs]);

  // al seleccionar una conversación, cargar su hilo y ver si ya tiene caso abierto
  const abrirConv = useCallback(async (conv) => {
    setSel(conv); setCargando(true); setError(null); setCasoAbierto(null);
    try {
      const msgs = await mensajesDeConversacion(conv.id);
      setMensajes(msgs);
      // ¿algún mensaje ya tiene caso? buscar el caso abierto
      const conCaso = msgs.find((m) => m.case_id);
      if (conCaso) {
        const { data } = await sb.from("crm_inc_casos")
          .select("*").eq("case_id", conCaso.case_id).maybeSingle();
        if (data && ["NEW","OPEN","ON_HOLD","CHECKING"].includes(data.estado_id)) {
          setCasoAbierto(data);
        }
      }
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }, []);

  // tomar la consulta: crea el caso y cambia a la vista de hilo con caso
  async function tomarConsulta() {
    if (!sel || creando) return;
    setCreando(true); setError(null);
    try {
      const caseId = await crearCasoConsulta(sel.id, analista?.id);
      const { data } = await sb.from("crm_inc_casos").select("*").eq("case_id", caseId).maybeSingle();
      setCasoAbierto(data);
      await cargarConvs();
    } catch (e) { setError(e.message); }
    finally { setCreando(false); }
  }

  // resolver/cerrar el caso de verdad (RPC), luego volver a la lista
  async function resolverCaso(caso) {
    if (!caso) return;
    try {
      const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: caso.id, p_estado: "CLOSED" });
      if (error) { setError("No se pudo cerrar: " + error.message); return; }
      setCasoAbierto(null);
      await cargarConvs();
      if (sel) await abrirConv(sel);  // recarga el hilo, ahora cerrado
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

      {/* panel derecho: hilo de la conversación o caso tomado */}
      {!sel ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>
          Selecciona una conversación
        </div>
      ) : casoAbierto ? (
        // ya tiene caso: usar el hilo normal con todas sus funciones
        <HiloTicket caso={casoAbierto} analistaId={analista?.id}
          onTomar={() => {}} onResolver={resolverCaso} />
      ) : (
        // conversación sin caso: mostrar hilo + botón Tomar consulta
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{sel.conductor_nombre || sel.telefono}</div>
            <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>{sel.telefono} · consulta sin caso</div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)",
            display: "flex", flexDirection: "column", gap: 8 }}>
            {cargando ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
            ) : mensajes.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Sin mensajes</div>
            ) : mensajes.map((m) => <Burbuja key={m.id} m={m} />)}
          </div>
          <div style={{ borderTop: "1px solid var(--borde)", padding: "11px 16px" }}>
            {error && <div style={{ fontSize: 12, color: "#bb4444", marginBottom: 8 }}>{error}</div>}
            <button className="btn-navy" onClick={tomarConsulta} disabled={creando}
              style={{ width: "100%", padding: "10px" }}>
              {creando ? "Creando caso…" : "Tomar consulta y crear caso"}
            </button>
            <div style={{ fontSize: 11, color: "var(--texto-tenue)", textAlign: "center", marginTop: 6 }}>
              Se genera un caso (BT-…), se vinculan los mensajes y empieza el cronómetro de resolución.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
