import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora, diaMX } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta, conversacionPorTelefono, ventanaAbierta, enviarMensaje, resumenIA, consultarPaquete } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";
import { ETIQUETAS_CASO, SERVICE_CENTERS_MX } from "../shared/constantes.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONSULTAS EN RUTA v2 · tres columnas
//  [1] conversaciones del día (selector de fecha, hoy por defecto)
//  [2] hilo de mensajes (la columna protagonista)
//  [3] caracterización del ticket: etiquetas, SC, comentarios (con IA)
// Al cerrar un ticket con etiqueta GRAVE se anota solo en la Bitácora del día.
// ═══════════════════════════════════════════════════════════════════════════

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
          {["texto", "plantilla"].includes(m.tipo_contenido) ? m.texto : `[${m.tipo_contenido}]${m.texto ? " " + m.texto : ""}`}
        </div>
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3, textAlign: "right" }}>
          {fechaHora(m.creado_en)}{saliente && m.estado_entrega ? ` · ${m.estado_entrega}` : ""}
        </div>
      </div>
    </div>
  );
}

function LineaCierre({ codigo }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
      <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.45 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: "#15803d", whiteSpace: "nowrap" }}>✓ {codigo} resuelto</span>
      <div style={{ flex: 1, height: 2, background: "#16a34a", opacity: 0.45 }} />
    </div>
  );
}

// contexto del conductor: teléfono → directorio → ruta de hoy (SC prefill)
async function buscarContexto(telefono) {
  const out = { nombre: null, sc: null, ruta: null };
  try {
    const t10 = String(telefono || "").replace(/\D/g, "").slice(-10);
    if (!t10) return out;
    const { data: dir } = await sb.from("vw_directorio_conductores")
      .select("driver_id, nombre").like("telefono", `%${t10}`).limit(1);
    const d = dir && dir[0];
    if (!d) return out;
    out.nombre = d.nombre || null;
    if (d.driver_id > 0) {
      const { data: rt } = await sb.from("vw_rutas_mx_ultimo")
        .select("service_center_id, id_ruta").eq("driver_id", d.driver_id).limit(1);
      if (rt && rt[0]) { out.sc = rt[0].service_center_id; out.ruta = rt[0].id_ruta; }
    }
  } catch (e) { /* el contexto es opcional */ }
  return out;
}


// ── Buscador puntual de paquetes (endpoint shipments de MELI) ───────────────
const ESTADO_PKG = {
  delivered: "Entregado", on_route: "En ruta", not_delivered: "No entregado",
  to_be_dispatched: "Por despachar", at_the_door: "En la puerta",
};
function BuscadorPaquete({ onPasarAlChofer }) {
  const [id, setId] = useState("");
  const [pkg, setPkg] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState("");

  async function buscar() {
    const limpio = id.replace(/\D/g, "");
    if (!limpio || buscando) return;
    setBuscando(true); setErr(""); setPkg(null);
    try { setPkg(await consultarPaquete(limpio)); }
    catch (e) { setErr(e.message || "No se pudo consultar"); }
    finally { setBuscando(false); }
  }

  const textoChofer = pkg ? [
    `📦 Paquete ${pkg.id}`,
    pkg.comprador?.nombre ? `Cliente: ${pkg.comprador.nombre}` : null,
    pkg.comprador?.telefono ? `Tel: ${pkg.comprador.telefono}` : null,
    pkg.comprador?.direccion ? `Dirección: ${pkg.comprador.direccion}` : null,
    pkg.comprador?.comentario ? `Referencia: ${pkg.comprador.comentario}` : null,
  ].filter(Boolean).join("\n") : "";

  return (
    <div style={{ borderBottom: "1px solid var(--borde)", paddingBottom: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🔍 Buscar paquete</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input value={id} onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          placeholder="ID de envío (ej. 47622146432)"
          style={{ flex: 1, fontSize: 12.5, padding: "6px 10px", border: "1px solid var(--borde)", borderRadius: 7 }} />
        <button onClick={buscar} disabled={buscando || !id.trim()} style={{ fontSize: 12, padding: "6px 12px" }}>
          {buscando ? "…" : "Buscar"}
        </button>
      </div>
      {err && <div style={{ fontSize: 12, color: "#791F1F", marginBottom: 8 }}>{err}</div>}
      {pkg && (
        <div style={{ background: "#fafbfc", border: "1px solid var(--borde)", borderRadius: 8, padding: "10px 12px", fontSize: 12, lineHeight: 1.8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <b>{pkg.id}</b>
            <span className="pill" style={{ background: pkg.substatus === "delivered" ? "#dcfce7" : "#fef3c7",
              color: pkg.substatus === "delivered" ? "#166534" : "#92400e" }}>
              {ESTADO_PKG[pkg.substatus] || ESTADO_PKG[pkg.status] || pkg.substatus || pkg.status}
            </span>
          </div>
          {pkg.comprador?.nombre && <div><span style={{ color: "var(--texto-suave)" }}>Cliente:</span> {pkg.comprador.nombre}</div>}
          {pkg.comprador?.telefono && <div><span style={{ color: "var(--texto-suave)" }}>Teléfono:</span> <b>{pkg.comprador.telefono}</b></div>}
          {pkg.comprador?.direccion && <div><span style={{ color: "var(--texto-suave)" }}>Dirección:</span> {pkg.comprador.direccion}</div>}
          {pkg.comprador?.comentario && <div><span style={{ color: "var(--texto-suave)" }}>Referencia:</span> {pkg.comprador.comentario}</div>}
          {pkg.recibio && <div><span style={{ color: "var(--texto-suave)" }}>Recibió:</span> {pkg.recibio.nombre}{pkg.recibio.relacion ? ` (${pkg.recibio.relacion})` : ""}</div>}
          {pkg.ruta && <div><span style={{ color: "var(--texto-suave)" }}>Ruta:</span> {pkg.ruta}</div>}
          {onPasarAlChofer && (
            <button onClick={() => onPasarAlChofer(textoChofer)}
              style={{ marginTop: 8, fontSize: 12, padding: "6px 12px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", width: "100%" }}>
              📤 Pasar datos al chofer
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Consultas() {
  const [nombresAnalistas, setNombresAnalistas] = useState({});
  useEffect(() => {
    sb.from("crm_analistas").select("id, nombre").then(({ data }) => {
      setNombresAnalistas(Object.fromEntries((data || []).map((a) => [a.id, a.nombre])));
    });
  }, []);
  const { analista } = useAuth();
  const { marcarVistos } = useAlertas();
  const [convs, setConvs] = useState([]);
  const [fechaSel, setFechaSel] = useState(diaMX());
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [casos, setCasos] = useState({});
  const [ticketAbierto, setTicketAbierto] = useState(null);
  const [haySinCaso, setHaySinCaso] = useState(false);
  const [texto, setTexto] = useState("");
  const [conversacion, setConversacion] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [accion, setAccion] = useState(false);
  const [error, setError] = useState(null);
  // panel de caracterización
  const [caract, setCaract] = useState({ sc: "", etiquetas: [], comentarios: "" });
  const [contexto, setContexto] = useState({ nombre: null, sc: null, ruta: null });
  const [guardando, setGuardando] = useState(false);
  const [generandoIA, setGenerandoIA] = useState(false);
  const [avisoPanel, setAvisoPanel] = useState("");
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

  useEffect(() => {
    const canal = sb.channel("consultas-lista")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_conversaciones" }, cargarConvs)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarConvs]);

  useEffect(() => {
    if (!sel) return;
    const canal = sb.channel(`consulta-hilo-${sel.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crm_inc_mensajes", filter: `conversacion_id=eq.${sel.id}` },
        () => { if (selRef.current) cargarHilo(selRef.current); })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [sel, cargarHilo]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mensajes.length]);

  // al cambiar el ticket abierto: cargar su caracterización + contexto de ruta
  useEffect(() => {
    setAvisoPanel("");
    if (!sel) { setCaract({ sc: "", etiquetas: [], comentarios: "" }); setContexto({ nombre: null, sc: null, ruta: null }); return; }
    let vivo = true;
    buscarContexto(sel.telefono).then((ctx) => {
      if (!vivo) return;
      setContexto(ctx);
      setCaract({
        sc: ticketAbierto?.estacion_origen || ctx.sc || "",
        etiquetas: Array.isArray(ticketAbierto?.etiquetas) ? ticketAbierto.etiquetas : [],
        comentarios: ticketAbierto?.comentarios || "",
      });
    });
    return () => { vivo = false; };
  }, [sel?.id, ticketAbierto?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function abrirConv(conv) {
    setSel(conv); setCargando(true); setError(null);
    setMensajes([]); setCasos({}); setTicketAbierto(null); setHaySinCaso(false);
    try {
      leidosRef.current.add(conv.id);
      setConvs((prev) => prev.map((c) => c.id === conv.id ? { ...c, no_leidos: 0 } : c));
      sb.from("crm_inc_conversaciones").update({ no_leidos: 0 }).eq("id", conv.id).then(() => {});
      await cargarHilo(conv);
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }

  async function tomar() {
    if (!sel || accion) return;
    setAccion(true); setError(null);
    try {
      await crearCasoConsulta(sel.id, analista?.id);
      await cargarHilo(sel);
      await cargarConvs();
    } catch (e) { setError(e.message); }
    finally { setAccion(false); }
  }

  // guarda etiquetas/SC/comentarios en el ticket abierto
  async function guardarCaract(silencioso) {
    if (!ticketAbierto) return false;
    setGuardando(true);
    try {
      const { error } = await sb.rpc("fn_caracterizar_ticket", {
        p_caso_id: ticketAbierto.id,
        p_etiquetas: caract.etiquetas,
        p_comentarios: caract.comentarios || null,
      });
      if (error) throw error;
      if (!silencioso) setAvisoPanel("Guardado ✓");
      return true;
    } catch (e) {
      setAvisoPanel("No se pudo guardar: " + e.message);
      return false;
    } finally { setGuardando(false); }
  }

  // cerrar: guarda caracterización, resuelve el ticket y, si hay etiqueta
  // GRAVE, anota automáticamente en la Bitácora del día
  async function tomarTicketConsulta() {
    if (!ticketAbierto) return;
    const forzar = !!(ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id);
    if (forzar) {
      const dueno = nombresAnalistas[ticketAbierto.analista_actual] || "otro analista";
      if (!window.confirm(`Este ticket lo tiene ${dueno}. ¿Traspasártelo?`)) return;
    }
    const { error } = await sb.rpc("fn_tomar_ticket", { p_caso_id: ticketAbierto.id, p_forzar: forzar });
    if (error) { setAvisoPanel(error.message.includes("ya tomado") ? error.message : "No se pudo tomar: " + error.message); return; }
    if (sel) await cargarHilo(sel);
  }

  async function cerrar() {
    if (!ticketAbierto || accion) return;
    setAccion(true); setError(null);
    try {
      const guardo = await guardarCaract(true);
      if (!guardo) return;
      const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: ticketAbierto.id, p_estado: "CLOSED" });
      if (error) { setError("No se pudo cerrar: " + error.message); return; }

      const graves = ETIQUETAS_CASO.filter((e) => e.grave && caract.etiquetas.includes(e.id));
      if (graves.length) {
        const { error: eBit } = await sb.from("crm_bitacora_dia").insert({
          sc: caract.sc || null,
          chofer: sel.conductor_nombre || contexto.nombre || null,
          telefono: sel.telefono,
          case_id: String(ticketAbierto.case_id),
          codigo: ticketAbierto.codigo || null,
          etiquetas: caract.etiquetas,
          detalle: caract.comentarios || null,
          creado_por: analista?.user_id || null,
        });
        if (eBit) setError("Ticket cerrado, pero la Bitácora falló: " + eBit.message);
        else setAvisoPanel(`Cerrado y anotado en Bitácora (${graves.map((g) => g.label).join(", ")})`);
      }
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

  // resumen IA de la conversación → campo comentarios
  async function generarResumen() {
    if (generandoIA || mensajes.length === 0) return;
    setGenerandoIA(true); setAvisoPanel("");
    try {
      // Solo el tramo del TICKET ACTUAL: se corta en el último mensaje que
      // pertenezca a un ticket anterior (los mensajes sin caso posteriores,
      // como la plantilla inicial, sí entran). Así un ticket nuevo en el mismo
      // hilo no arrastra la historia del anterior.
      const casoActual = String(ticketAbierto?.case_id ?? "");
      let corte = -1;
      mensajes.forEach((m, i) => {
        if (m.case_id != null && String(m.case_id) !== casoActual) corte = i;
      });
      const delTicket = mensajes.slice(corte + 1);
      const transcript = delTicket.slice(-40)
        .map((m) => `${m.direccion === "entrante" ? "Conductor" : (m.emisor === "ia" ? "IA" : "Analista")}: ${m.texto || `[${m.tipo_contenido}]`}`)
        .join("\n");
      const resumen = await resumenIA(transcript);
      setCaract((p) => ({ ...p, comentarios: resumen }));
      setAvisoPanel("Resumen generado — revísalo y guarda.");
    } catch (e) {
      setAvisoPanel("IA no disponible: " + (e.message || "error"));
    } finally { setGenerandoIA(false); }
  }

  function toggleEtiqueta(id) {
    setCaract((p) => ({
      ...p,
      etiquetas: p.etiquetas.includes(id) ? p.etiquetas.filter((x) => x !== id) : [...p.etiquetas, id],
    }));
  }

  const ventana = ventanaAbierta(conversacion);
  const convsDelDia = convs.filter((c) => c.ultimo_mensaje_en && diaMX(c.ultimo_mensaje_en) === fechaSel);
  const hayGrave = ETIQUETAS_CASO.some((e) => e.grave && caract.etiquetas.includes(e.id));

  function renderHilo() {
    const out = [];
    for (let i = 0; i < mensajes.length; i++) {
      const m = mensajes[i];
      out.push(<Burbuja key={m.id} m={m} />);
      const cid = m.case_id;
      const sig = mensajes[i + 1];
      const cambiaTicket = !sig || sig.case_id !== cid;
      if (cid && cambiaTicket && casos[cid] && !ABIERTOS.includes(casos[cid].estado_id)) {
        out.push(<LineaCierre key={`cierre-${cid}`} codigo={casos[cid].codigo || "#" + cid} />);
      }
    }
    return out;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(270px, 0.75fr) 1.7fr minmax(270px, 0.8fr)", height: "100%" }}>
      {/* ── COLUMNA 1 · conversaciones del día ── */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--borde)",
          position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Consultas en ruta</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="date" value={fechaSel} max={diaMX()}
              onChange={(e) => setFechaSel(e.target.value || diaMX())}
              style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--borde)", borderRadius: 7, flex: 1 }} />
            {fechaSel !== diaMX() && (
              <button onClick={() => setFechaSel(diaMX())} style={{ fontSize: 12, padding: "5px 10px" }}>Hoy</button>
            )}
          </div>
        </div>
        {convsDelDia.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>
            {fechaSel === diaMX() ? "Sin conversaciones hoy todavía" : `Sin conversaciones el ${fechaSel}`}
          </div>
        )}
        {convsDelDia.map((c) => {
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

      {/* ── COLUMNA 2 · hilo (protagonista) ── */}
      {!sel ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>
          Selecciona una conversación
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)", display: "flex",
            alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{sel.conductor_nombre || contexto.nombre || sel.telefono}</div>
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

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)",
            display: "flex", flexDirection: "column", gap: 8 }}>
            {cargando ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Cargando…</div>
            ) : mensajes.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>Sin mensajes</div>
            ) : renderHilo()}
            <div ref={finRef} />
          </div>

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
                    placeholder={ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id
                      ? `Ticket de ${nombresAnalistas[ticketAbierto.analista_actual] || "otro analista"} — traspásatelo para escribir`
                      : "Escribe al conductor…"}
                    disabled={accion || (ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id)} style={{ flex: 1 }} />
                  <button className="btn-navy" onClick={enviar} disabled={accion || !texto.trim() || (ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id)}
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

      {/* ── COLUMNA 3 · caracterización del ticket ── */}
      <div style={{ borderLeft: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        {!sel ? (
          <div style={{ padding: 20, fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>—</div>
        ) : (
          <div style={{ padding: 14 }}>
            <BuscadorPaquete onPasarAlChofer={(t) => setTexto((prev) => (prev ? prev + "\n" : "") + t)} />
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Ficha del ticket</div>

            {/* identidad */}
            <div style={{ fontSize: 12, color: "var(--texto)", lineHeight: 1.9, marginBottom: 12 }}>
              <div><span style={{ color: "var(--texto-suave)" }}>Ticket:</span> <b>{ticketAbierto ? (ticketAbierto.codigo || "#" + ticketAbierto.case_id) : "sin ticket abierto"}</b></div>
              <div><span style={{ color: "var(--texto-suave)" }}>Conductor:</span> {sel.conductor_nombre || contexto.nombre || "—"}</div>
              <div><span style={{ color: "var(--texto-suave)" }}>Teléfono:</span> {sel.telefono}</div>
              {ticketAbierto && (
                <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--texto-suave)" }}>Atendida por:</span>
                  {ticketAbierto.analista_actual
                    ? <b style={{ color: "var(--naranja)" }}>👤 {nombresAnalistas[ticketAbierto.analista_actual] || "analista"}</b>
                    : <span style={{ color: "var(--texto-tenue)" }}>nadie aún</span>}
                  {(!ticketAbierto.analista_actual || ticketAbierto.analista_actual !== analista?.id) && (
                    <button onClick={tomarTicketConsulta} style={{ fontSize: 11, padding: "3px 10px" }}>
                      {ticketAbierto.analista_actual ? "Traspasar a mí" : "Tomar"}
                    </button>
                  )}
                </div>
              )}
              {contexto.ruta && <div><span style={{ color: "var(--texto-suave)" }}>Ruta de hoy:</span> {contexto.ruta}</div>}
            </div>

            {ticketAbierto ? (
              <>
                {/* SC */}
                <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>Service Center</div>
                <select value={caract.sc} onChange={(e) => setCaract((p) => ({ ...p, sc: e.target.value }))}
                  style={{ width: "100%", fontSize: 13, padding: "7px 8px", border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 12, background: "#fff" }}>
                  <option value="">— sin SC —</option>
                  {SERVICE_CENTERS_MX.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>

                {/* etiquetas */}
                <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 6 }}>Etiquetas</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                  {ETIQUETAS_CASO.map((e) => {
                    const on = caract.etiquetas.includes(e.id);
                    return (
                      <button key={e.id} onClick={() => toggleEtiqueta(e.id)}
                        style={{ fontSize: 12, padding: "5px 10px", borderRadius: 14, cursor: "pointer",
                          border: `1px solid ${on ? (e.grave ? "#b91c1c" : "var(--navy)") : "var(--borde)"}`,
                          background: on ? (e.grave ? "#FCEBEB" : "#e0e7ff") : "#fff",
                          color: on ? (e.grave ? "#791F1F" : "var(--navy)") : "var(--texto-suave)" }}>
                        {e.label}
                      </button>
                    );
                  })}
                </div>
                {hayGrave && (
                  <div style={{ fontSize: 11, color: "#791F1F", background: "#FCEBEB", borderRadius: 7, padding: "6px 10px", marginBottom: 10 }}>
                    ⚠ Etiqueta grave: al cerrar el ticket se anota automáticamente en la Bitácora del día.
                  </div>
                )}

                {/* comentarios + IA */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--texto-suave)" }}>Comentarios / resumen</span>
                  <button onClick={generarResumen} disabled={generandoIA || mensajes.length === 0}
                    title="Genera un resumen de la conversación con IA"
                    style={{ fontSize: 11, padding: "3px 10px" }}>
                    {generandoIA ? "Generando…" : "✨ Resumen IA"}
                  </button>
                </div>
                <textarea value={caract.comentarios}
                  onChange={(e) => setCaract((p) => ({ ...p, comentarios: e.target.value }))}
                  rows={6} placeholder="Qué pasó, qué se gestionó, cómo quedó…"
                  style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: 9, border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />

                {avisoPanel && <div style={{ fontSize: 11, color: avisoPanel.startsWith("No") || avisoPanel.startsWith("IA") ? "#791F1F" : "#15803d", marginTop: 6 }}>{avisoPanel}</div>}

                <button className="btn-navy" onClick={() => guardarCaract(false)} disabled={guardando}
                  style={{ width: "100%", padding: "9px", marginTop: 10 }}>
                  {guardando ? "Guardando…" : "Guardar ficha"}
                </button>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--texto-tenue)", background: "var(--fondo)", borderRadius: 8, padding: "10px 12px" }}>
                Toma la consulta para caracterizar el ticket. Al cerrar uno y abrirse otra conversación, se genera un ID nuevo con su propia ficha.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
