import { useState, useEffect, useRef, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { diaMX, fechaHora } from "../shared/fechas.js";
import { Link } from "react-router-dom";
import { detectarCaseId, trozosConTickets, rutaDeTicket, esConsulta } from "../shared/chat.js";

// ═══════════════════════════════════════════════════════════════════════════
// MENSAJES · chat interno de la torre, un hilo por día.
//
// Mismo espíritu que el chat BT ↔ tercero de Certificaciones, con tres
// diferencias: el autor es el analista logueado (no un rol fijo), el hilo se
// organiza por día como la Bitácora, y llega por Realtime en vez de recargar.
//
// La identidad no se puede falsear: la policy de RLS exige que analista_id
// corresponda al auth.uid() que escribe.
// ═══════════════════════════════════════════════════════════════════════════

const COLORES_AUTOR = ["#1a3a6b", "#0e7490", "#7c3aed", "#b45309", "#15803d", "#be123c"];

// Color estable por analista, derivado del uuid: el mismo siempre.
function colorDe(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return COLORES_AUTOR[h % COLORES_AUTOR.length];
}

function iniciales(nombre) {
  if (!nombre) return "··";
  return nombre.replace(/[^\p{L}\s]/gu, "").trim()
    .split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "··";
}

// ── Hook del contador para el Topbar ────────────────────────────────────────
export function useChatNoLeidos() {
  const [n, setN] = useState(0);

  const refrescar = useCallback(async () => {
    const { data, error } = await sb.rpc("fn_chat_no_leidos");
    if (!error) setN(data || 0);
  }, []);

  useEffect(() => {
    refrescar();
    const canal = sb.channel("chat-badge")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_chat_analistas" },
        refrescar)
      .subscribe();
    const t = setInterval(refrescar, 60000);   // respaldo si Realtime se cae
    return () => { sb.removeChannel(canal); clearInterval(t); };
  }, [refrescar]);

  return n;
}

// ── Un mensaje ──────────────────────────────────────────────────────────────
function Mensaje({ m, esMio, mostrarAutor }) {
  const color = colorDe(m.analista_id);
  return (
    <div style={{ display: "flex", justifyContent: esMio ? "flex-end" : "flex-start", gap: 8 }}>
      {!esMio && (
        <div style={{
          width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
          background: mostrarAutor ? color : "transparent",
          color: "#fff", fontSize: 10.5, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          alignSelf: "flex-end",
        }} title={m.autor_nombre}>
          {mostrarAutor ? iniciales(m.autor_nombre) : ""}
        </div>
      )}
      <div style={{
        maxWidth: "72%", padding: "8px 12px", borderRadius: 12,
        background: esMio ? "var(--navy)" : "#fff",
        color: esMio ? "#fff" : "var(--texto)",
        border: esMio ? "none" : "1px solid var(--borde)",
        borderBottomRightRadius: esMio ? 4 : 12,
        borderBottomLeftRadius: esMio ? 12 : 4,
      }}>
        {!esMio && mostrarAutor && (
          <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 3 }}>
            {m.autor_nombre}
            {m.autor_rol === "ia" ? " 🤖" : m.autor_rol === "admin" ? " ·  admin" : ""}
          </div>
        )}
        <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {trozosConTickets(m.texto).map((t, i) =>
            t.tipo === "ticket" ? (
              <Link key={i} to={rutaDeTicket(t.caseId)}
                style={{ color: esMio ? "#c7d2fe" : "var(--naranja)", fontWeight: 600 }}>
                {t.valor}
              </Link>
            ) : <span key={i}>{t.valor}</span>
          )}
        </div>
        {m.case_id && (
          <Link to={rutaDeTicket(m.case_id)}
            title={esConsulta(m.case_id) ? "Abrir en Consultas" : "Abrir en Incidencias"}
            style={{
              marginTop: 5, fontSize: 11, display: "block", textDecoration: "none",
              borderTop: `1px solid ${esMio ? "rgba(255,255,255,.25)" : "var(--borde)"}`,
              paddingTop: 4, color: esMio ? "#c7d2fe" : "var(--naranja)", fontWeight: 600,
            }}>
            🎫 Abrir #{m.case_id} en {esConsulta(m.case_id) ? "Consultas" : "Incidencias"} →
          </Link>
        )}
        <div style={{ fontSize: 9.5, opacity: 0.6, marginTop: 4, textAlign: "right" }}>
          {fechaHora(m.creado_en)}
        </div>
      </div>
    </div>
  );
}

// ── Módulo ──────────────────────────────────────────────────────────────────
export default function Mensajes() {
  const { analista } = useAuth();
  const [fechaSel, setFechaSel] = useState(diaMX());
  const [msgs, setMsgs] = useState(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [enLinea, setEnLinea] = useState([]);
  const finRef = useRef(null);

  const esHoy = fechaSel === diaMX();

  const cargar = useCallback(async () => {
    const { data, error } = await sb
      .from("vw_chat_analistas")
      .select("*")
      .eq("fecha", fechaSel)
      .order("creado_en", { ascending: true });
    if (error) { setError(error.message); setMsgs([]); return; }
    setError(null);
    setMsgs(data || []);
  }, [fechaSel]);

  useEffect(() => { setMsgs(null); cargar(); }, [cargar]);

  // Realtime: los mensajes de hoy llegan solos.
  useEffect(() => {
    if (!esHoy) return;
    const canal = sb.channel("chat-torre")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_chat_analistas" },
        () => cargar())
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [esHoy, cargar]);

  // Presencia: quién más tiene la pestaña abierta ahora mismo.
  useEffect(() => {
    if (!analista?.id) return;
    const canal = sb.channel("chat-presencia", {
      config: { presence: { key: analista.id } },
    });
    canal
      .on("presence", { event: "sync" }, () => {
        const estado = canal.presenceState();
        const otros = Object.values(estado).flat()
          .map((p) => p.nombre)
          .filter((n) => n && n !== analista.nombre);
        setEnLinea([...new Set(otros)]);
      })
      .subscribe(async (st) => {
        if (st === "SUBSCRIBED") await canal.track({ nombre: analista.nombre });
      });
    return () => { sb.removeChannel(canal); };
  }, [analista?.id, analista?.nombre]);

  // Marcar leído al abrir y cada vez que llegan mensajes nuevos.
  useEffect(() => {
    if (esHoy && msgs) sb.rpc("fn_chat_marcar_leido");
  }, [esHoy, msgs]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs?.length]);

  async function enviar() {
    const t = texto.trim();
    if (!t || enviando || !analista?.id) return;
    setEnviando(true); setError(null);
    // La fecha la pone el trigger en hora de México: no se manda desde acá.
    // Si mencionas un #123456 en el texto, el chip del ticket se genera solo.
    const { error } = await sb.from("crm_chat_analistas")
      .insert({ analista_id: analista.id, texto: t, case_id: detectarCaseId(t) });
    if (error) setError(error.message);
    else { setTexto(""); await cargar(); }
    setEnviando(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
      {/* Cabecera */}
      <div style={{
        padding: "11px 16px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Mensajes de la torre</div>
          <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginTop: 2 }}>
            {enLinea.length > 0
              ? <>🟢 {enLinea.join(", ")} {enLinea.length === 1 ? "está" : "están"} en línea</>
              : "Hilo interno entre analistas · un hilo por día"}
          </div>
        </div>
        <input type="date" value={fechaSel} max={diaMX()}
          onChange={(e) => setFechaSel(e.target.value || diaMX())}
          style={{ fontSize: 12, padding: "6px 8px", border: "1px solid var(--borde)", borderRadius: 7 }} />
        {!esHoy && (
          <button onClick={() => setFechaSel(diaMX())} style={{ fontSize: 12, padding: "6px 12px" }}>Hoy</button>
        )}
      </div>

      {/* Hilo */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto", padding: 16,
        background: "var(--fondo)", display: "flex", flexDirection: "column", gap: 6,
      }}>
        {msgs === null ? (
          <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
        ) : msgs.length === 0 ? (
          <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>
            {esHoy
              ? <>Sin mensajes hoy.<br />Escribe el primero abajo.</>
              : <>No hubo mensajes el {fechaSel}.</>}
          </div>
        ) : (
          msgs.map((m, i) => {
            const prev = msgs[i - 1];
            // Agrupa mensajes seguidos del mismo autor: solo el primero lleva nombre.
            const mostrarAutor = !prev || prev.analista_id !== m.analista_id;
            return (
              <Mensaje key={m.id} m={m} esMio={m.analista_id === analista?.id}
                mostrarAutor={mostrarAutor} />
            );
          })
        )}
        <div ref={finRef} />
      </div>

      {/* Composición */}
      <div style={{ borderTop: "1px solid var(--borde)" }}>
        {error && (
          <div style={{ padding: "6px 16px", fontSize: 12, color: "#bb4444", background: "#fff5f5" }}>{error}</div>
        )}
        {esHoy ? (
          <div style={{ padding: "11px 16px", display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={texto} rows={2}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
              placeholder="Escribe al equipo…  menciona #900000021 para enlazar un ticket"
              disabled={enviando}
              style={{
                flex: 1, border: "1px solid var(--borde)", borderRadius: 10,
                padding: "9px 12px", fontSize: 13, fontFamily: "inherit", resize: "vertical",
              }} />
            <button className="btn-navy" onClick={enviar} disabled={enviando || !texto.trim()}
              style={{ padding: "9px 18px", whiteSpace: "nowrap" }}>
              {enviando ? "…" : "Enviar"}
            </button>
          </div>
        ) : (
          <div style={{
            padding: "12px 16px", textAlign: "center", fontSize: 12.5,
            color: "var(--texto-suave)", background: "#f8fafc",
          }}>
            Estás viendo un día anterior · vuelve a <b>Hoy</b> para escribir
          </div>
        )}
      </div>
    </div>
  );
}
