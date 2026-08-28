import { useState, useEffect, useRef, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import {
  listarConversaciones, mensajesDeConversacion, marcarLeidos,
  encolarTexto, ventanaAbierta, horasDeVentana,
} from "../shared/mensajes-pnr.js";
import BurbujaPnr from "../componentes/BurbujaPnr.jsx";
import BotonAdjuntoPnr from "../componentes/BotonAdjuntoPnr.jsx";
import GrabadorAudioPnr from "../componentes/GrabadorAudioPnr.jsx";
import SelectorEmoji from "../componentes/SelectorEmoji.jsx";
import BotonLlamar from "../componentes/BotonLlamar.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// CHAT POSVENTA · dos columnas
//   [1] conversaciones, ordenadas por último mensaje
//   [2] el hilo, con el contexto del caso arriba
//
// Es el canal del número +52 1 55 1907 2552, separado del de The Eyes. Sirve
// para resolver dudas del conductor sobre un reclamo: qué se le pide, de qué
// entrega, hasta cuándo.
//
// LO QUE NO ES
//   No es el repositorio de pruebas. La foto que defiende un caso ante MELI la
//   carga el supervisor desde su bitácora, donde queda ligada a la vuelta y
//   registrada. Una imagen suelta del chat no es evidencia de nada.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1a3a6b", naranja: "#F47B20", verde: "#1f7a5c", ladrillo: "#9e3b1b",
  gris: "#8a94a6", grisTenue: "#f4f6f9",
};

function hora(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// Día en hora de México, formato YYYY-MM-DD.
function diaMX(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function hoyMX() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function hace(iso) {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `${min} min`;
  if (min < 2880) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

const dinero = (n) => n == null ? "—"
  : "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });

// ── Fila de la bandeja ─────────────────────────────────────────────────────

function FilaConv({ c, activa, onClick }) {
  const abierta = ventanaAbierta(c.ultimo_entrante_en);
  return (
    <div onClick={onClick} style={{
      padding: "9px 12px", borderBottom: "1px solid var(--borde)", cursor: "pointer",
      background: activa ? "#eef2f8" : c.no_leidos > 0 ? "#fffaf5" : "#fff",
      borderLeft: `3px solid ${activa ? C.navy : c.no_leidos > 0 ? C.naranja : "transparent"}`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: c.no_leidos > 0 ? 700 : 500,
          color: "var(--texto)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.conductor || c.telefono}
        </span>
        {c.no_leidos > 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, background: C.naranja, color: "#fff",
            borderRadius: 10, padding: "1px 6px" }}>{c.no_leidos}</span>
        )}
        <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>{hace(c.ultimo_en)}</span>
      </div>

      {/* Solo el último mensaje, como cualquier bandeja de chat. Antes había una
          línea con el caso y el monto debajo del nombre, y se confundía con el
          mensaje: el contexto del caso ya está en el encabezado del hilo. */}
      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginTop: 2,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {c.ultima_direccion === "saliente" ? "→ " : ""}
        {c.ultimo_texto
          ? c.ultimo_texto
          : c.ultima_direccion
            // Hay mensaje pero sin texto: es una foto, un audio o un documento.
            ? "adjunto"
            // No hay ningún mensaje. Antes decía "(adjunto)" y hacía pensar que
            // había llegado algo que no se podía ver.
            : "sin mensajes"}
      </div>

      {/* La ventana de 24 h decide si se puede escribir texto libre. Verlo en la
          bandeja evita abrir un hilo para descubrir que hay que usar plantilla. */}
      {!abierta && (
        <div style={{ fontSize: 9.5, color: C.ladrillo, marginTop: 2 }}>
          ventana cerrada
        </div>
      )}
    </div>
  );
}

// ── Módulo ─────────────────────────────────────────────────────────────────

export default function ChatPosventa() {
  const { analista } = useAuth();
  const [convs, setConvs] = useState([]);
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [texto, setTexto] = useState("");
  const [cargando, setCargando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [busqueda, setBusqueda] = useState("");
  // Día de la bandeja, como en Consultas de la torre. Sin esto la lista acumula
  // conversaciones de días anteriores y el analista no distingue lo que llegó
  // hoy de lo que quedó de ayer.
  const [dia, setDia] = useState(() => hoyMX());
  const hiloRef = useRef(null);

  const cargarConvs = useCallback(async () => {
    try {
      setConvs(await listarConversaciones());
    } catch (e) {
      setError(e.message);
    } finally {
      setCargando(false);
    }
  }, []);

  const cargarHilo = useCallback(async (conv) => {
    if (!conv) return;
    try {
      setMensajes(await mensajesDeConversacion(conv.id));
      if (conv.no_leidos > 0) {
        await marcarLeidos(conv.id);
        setConvs((prev) => prev.map((x) => x.id === conv.id ? { ...x, no_leidos: 0 } : x));
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);

  // Realtime sobre los mensajes: el hilo abierto se mueve solo y la bandeja se
  // reordena. Sin esto el analista tendría que apretar Actualizar para saber
  // que el conductor contestó, y en la práctica no lo aprieta.
  useEffect(() => {
    const canal = sb.channel("pnr-chat")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pnr_mensajes_mx" },
        (payload) => {
          const m = payload.new;
          if (!m) return;
          if (sel && m.conversacion_id === sel.id) {
            setMensajes((prev) => {
              const i = prev.findIndex((x) => x.id === m.id);
              if (i >= 0) { const n = prev.slice(); n[i] = m; return n; }
              return [...prev, m];
            });
            if (payload.eventType === "INSERT" && m.direccion === "entrante") {
              marcarLeidos(sel.id).catch(() => {});
            }
          }
          cargarConvs();
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [sel, cargarConvs]);

  // Bajar al último mensaje. Va después de pintar para que la altura ya esté
  // calculada; con scroll inmediato queda a media altura.
  useEffect(() => {
    const t = setTimeout(() => {
      if (hiloRef.current) hiloRef.current.scrollTop = hiloRef.current.scrollHeight;
    }, 60);
    return () => clearTimeout(t);
  }, [mensajes]);

  function abrir(conv) {
    setSel(conv);
    setMensajes([]);
    setError(null);
    cargarHilo(conv);
  }

  async function enviar() {
    if (!sel || !texto.trim() || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await encolarTexto({
        conversacionId: sel.id,
        telefono: sel.telefono,
        caseId: sel.case_id,
        texto,
        emisor: "analista",
      });
      setTexto("");
      await cargarHilo(sel);
    } catch (e) {
      setError(e.message);
    } finally {
      setEnviando(false);
    }
  }

  const q = busqueda.trim().toLowerCase();
  // La búsqueda ignora el día a propósito: si el analista busca un caso, quiere
  // encontrarlo sin acordarse de qué día se habló.
  const lista = q
    ? convs.filter((c) => [c.conductor, c.telefono, c.case_id, c.route_id]
        .some((v) => String(v || "").toLowerCase().includes(q)))
    : convs.filter((c) => diaMX(c.ultimo_en) === dia);

  const abierta = sel ? ventanaAbierta(sel.ultimo_entrante_en) : false;
  const quedan = sel ? horasDeVentana(sel.ultimo_entrante_en) : 0;
  const sinLeer = convs.reduce((s, c) => s + (c.no_leidos || 0), 0);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, gap: 12 }}>

      {/* ── Bandeja ─────────────────────────────────────────────────────── */}
      <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column",
        border: "1px solid var(--borde)", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
        <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--borde)",
          background: C.grisTenue }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--texto)" }}>
              Conversaciones
            </span>
            {sinLeer > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, background: C.naranja, color: "#fff",
                borderRadius: 10, padding: "1px 7px" }}>{sinLeer}</span>
            )}
            <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--texto-tenue)" }}>
              {lista.length}
            </span>
          </div>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar conductor, teléfono o caso"
            style={{ width: "100%", fontSize: 11.5, padding: "5px 8px", borderRadius: 7,
              border: "1px solid var(--borde)", boxSizing: "border-box", marginBottom: 6 }} />

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="date" value={dia} max={hoyMX()} disabled={!!q}
              onChange={(e) => setDia(e.target.value)}
              style={{ flex: 1, fontSize: 11, padding: "3px 6px", borderRadius: 6,
                border: "1px solid var(--borde)", boxSizing: "border-box",
                opacity: q ? 0.5 : 1 }} />
            {dia !== hoyMX() && !q && (
              <button onClick={() => setDia(hoyMX())}
                style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 6,
                  border: "1px solid var(--borde)", background: "#fff",
                  color: "var(--texto-suave)", cursor: "pointer", whiteSpace: "nowrap" }}>
                Hoy
              </button>
            )}
          </div>
          {q && (
            <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", marginTop: 3 }}>
              La búsqueda mira todos los días
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {cargando ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
          ) : lista.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--texto-suave)", lineHeight: 1.5 }}>
              {q
                ? "Ningún resultado."
                : dia === hoyMX()
                  ? "Sin conversaciones hoy. Aparecen cuando se avisa un PNR o cuando un conductor responde."
                  : "Sin conversaciones ese día."}
            </div>
          ) : (
            lista.map((c) => (
              <FilaConv key={c.id} c={c} activa={sel?.id === c.id} onClick={() => abrir(c)} />
            ))
          )}
        </div>
      </div>

      {/* ── Hilo ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
        border: "1px solid var(--borde)", borderRadius: 12, background: "#fff", overflow: "hidden" }}>

        {!sel ? (
          <div style={{ margin: "auto", fontSize: 13, color: "var(--texto-tenue)" }}>
            Elige una conversación
          </div>
        ) : (
          <>
            {/* Encabezado: con quién se habla y si la ventana está abierta.
                Nada más. Tuvo por un rato el caso, el centro, la ruta, el monto
                y el producto en pastillas, y no servían: el analista abre el
                chat para hablar, y el detalle del caso lo mira en la pestaña
                PNR cuando lo necesita. */}
            <div style={{ borderBottom: "1px solid var(--borde)", background: C.grisTenue }}>

              <div style={{ display: "flex", alignItems: "baseline", gap: 10,
                padding: "10px 14px", flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>
                  {sel.conductor || sel.telefono}
                </span>
                <span style={{ fontSize: 11, color: "var(--texto-tenue)",
                  fontVariantNumeric: "tabular-nums" }}>
                  {sel.telefono}
                </span>
                {sel.rol === "supervisor" && (
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: C.navy,
                    background: "#e4ebf5", borderRadius: 4, padding: "1px 6px",
                    textTransform: "uppercase", letterSpacing: 0.3 }}>
                    supervisor
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 10.5,
                  color: abierta ? C.verde : C.ladrillo }}>
                  {abierta ? `ventana abierta · ${Math.floor(quedan)} h` : "ventana cerrada"}
                </span>
              </div>

            </div>

            <div ref={hiloRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16,
              background: "var(--fondo, #f4f6f9)", display: "flex", flexDirection: "column", gap: 8 }}>
              {mensajes.length === 0 ? (
                <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>
                  Sin mensajes
                </div>
              ) : (
                mensajes.map((m) => <BurbujaPnr key={m.id} m={m} />)
              )}
            </div>

            {error && (
              <div style={{ fontSize: 11.5, color: C.ladrillo, background: "#faece6",
                borderTop: `1px solid ${C.ladrillo}`, padding: "6px 14px" }}>
                {error}
              </div>
            )}

            {/* Compositor */}
            <div style={{ borderTop: "1px solid var(--borde)", padding: 10,
              display: "flex", gap: 6, alignItems: "flex-end" }}>
              <BotonAdjuntoPnr telefono={sel.telefono} caseId={sel.case_id}
                conversacionId={sel.id} disabled={enviando}
                onEnviado={() => cargarHilo(sel)} />
              <GrabadorAudioPnr telefono={sel.telefono} caseId={sel.case_id}
                conversacionId={sel.id} disabled={enviando}
                onEnviado={() => cargarHilo(sel)} />
              <SelectorEmoji disabled={enviando} onElegir={(e) => setTexto((t) => t + e)} />
              <BotonLlamar telefono={sel.telefono} nombre={sel.conductor} />

              {/* textarea y no input: los mensajes al conductor llevan dirección,
                  referencia y varias líneas, y en un campo de una línea no se
                  alcanza a revisar lo escrito. */}
              <textarea value={texto} rows={2}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
                }}
                placeholder={abierta
                  ? "Escribe al conductor…  (Enter envía · Shift+Enter salta línea)"
                  : "La ventana de 24 h está cerrada: el conductor no ha escrito hoy. Hay que avisarle con una plantilla desde la pestaña PNR."}
                disabled={enviando || !abierta}
                style={{
                  flex: 1, minWidth: 0, fontSize: 13, padding: "8px 10px", borderRadius: 8,
                  border: "1px solid var(--borde)", resize: "none", fontFamily: "inherit",
                  background: abierta ? "#fff" : C.grisTenue,
                }} />

              <button onClick={enviar} disabled={enviando || !abierta || !texto.trim()}
                style={{
                  fontSize: 13, fontWeight: 600, padding: "10px 18px", borderRadius: 9,
                  cursor: enviando || !abierta || !texto.trim() ? "default" : "pointer",
                  border: `1px solid ${abierta && texto.trim() ? C.naranja : "var(--borde)"}`,
                  background: abierta && texto.trim() ? C.naranja : "#fff",
                  color: abierta && texto.trim() ? "#fff" : "var(--texto-tenue)",
                }}>
                {enviando ? "…" : "Enviar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
