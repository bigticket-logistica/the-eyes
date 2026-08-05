import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora, diaMX } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta, conversacionPorTelefono, ventanaAbierta, enviarMensaje, resumenIA, consultarPaquete } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";
import { ETIQUETAS_CASO, SERVICE_CENTERS_MX } from "../shared/constantes.js";
import Burbuja from "../componentes/Burbuja.jsx";
import BotonCompartirChat from "../componentes/BotonCompartirChat.jsx";
import BotonAdjunto from "../componentes/BotonAdjunto.jsx";
import GrabadorAudio from "../componentes/GrabadorAudio.jsx";
import { hayAdjuntoMadurando } from "../shared/mensajes.js";
import { useSearchParams } from "react-router-dom";

// ═══════════════════════════════════════════════════════════════════════════
// CONSULTAS EN RUTA v2 · tres columnas
//  [1] conversaciones del día (selector de fecha, hoy por defecto)
//  [2] hilo de mensajes (la columna protagonista)
//  [3] caracterización del ticket: etiquetas, SC, comentarios (con IA)
// Al cerrar un ticket con etiqueta GRAVE se anota solo en la Bitácora del día.
// ═══════════════════════════════════════════════════════════════════════════

const ABIERTOS = ["NEW", "OPEN", "ON_HOLD", "CHECKING"];

function LineaCierre({ codigo, anidadoEn }) {
  const color = anidadoEn ? "#1a3a6b" : "#16a34a";
  const texto = anidadoEn ? `↩ ${codigo} anidado en la incidencia #${anidadoEn}` : `✓ ${codigo} resuelto`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
      <div style={{ flex: 1, height: 2, background: color, opacity: 0.45 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: anidadoEn ? "#1a3a6b" : "#15803d", whiteSpace: "nowrap" }}>{texto}</span>
      <div style={{ flex: 1, height: 2, background: color, opacity: 0.45 }} />
    </div>
  );
}

// Resuelve nombres del Directorio para una lista de conversaciones (en lote,
// por sufijo de 10 dígitos). Devuelve { telefono: nombre }.
async function nombresParaLista(convs) {
  const mapa = {};
  try {
    const pendientes = (convs || []).filter((c) => !c.conductor_nombre);
    const sufijos = [...new Set(pendientes
      .map((c) => String(c.telefono || "").replace(/\D/g, "").slice(-10))
      .filter((t) => t.length === 10))];
    if (!sufijos.length) return mapa;
    const filtros = sufijos.map((t) => `telefono.like.%${t}`).join(",");
    const { data } = await sb.from("vw_directorio_conductores")
      .select("nombre, telefono").or(filtros).limit(300);
    const porSufijo = {};
    for (const d of (data || [])) {
      const suf = String(d.telefono || "").replace(/\D/g, "").slice(-10);
      if (suf && porSufijo[suf] === undefined) porSufijo[suf] = d.nombre || null;
    }
    for (const c of pendientes) {
      const suf = String(c.telefono || "").replace(/\D/g, "").slice(-10);
      if (porSufijo[suf]) mapa[c.telefono] = porSufijo[suf];
    }
  } catch (e) { /* sin nombres, la lista muestra teléfonos */ }
  return mapa;
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
    const aviso = setTimeout(() => setErr("Despertando el buscador… un momento."), 2500);
    try { setPkg(await consultarPaquete(limpio)); setErr(""); }
    catch (e) { setErr(e.message || "No se pudo consultar. Reintenta en unos segundos."); }
    finally { clearTimeout(aviso); setBuscando(false); }
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


// ── Guardar un número desconocido en el Directorio ─────────────────────────
// Dos caminos: asociarlo a un conductor que YA existe (típico cuando cambió
// de teléfono o escribe desde otro equipo) o crear uno nuevo. Asociar evita
// registros duplicados del mismo chofer.
function ModalGuardarNumero({ telefono, onCerrar, onGuardado, analistaId }) {
  const [modo, setModo] = useState("existente");
  const [q, setQ] = useState("");
  const [candidatos, setCandidatos] = useState([]);
  const [elegido, setElegido] = useState(null);
  const [nuevo, setNuevo] = useState({ nombre: "", patente: "", email: "" });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  // buscar conductores del padrón por nombre o patente
  useEffect(() => {
    const t = q.trim();
    if (modo !== "existente" || t.length < 2) { setCandidatos([]); return; }
    const timer = setTimeout(async () => {
      const { data } = await sb.from("vw_directorio_conductores")
        .select("driver_id, nombre, telefono, patente, email")
        .or(`nombre.ilike.%${t}%,patente.ilike.%${t}%`)
        .limit(12);
      setCandidatos(data || []);
    }, 300);
    return () => clearTimeout(timer);
  }, [q, modo]);

  const tel = String(telefono || "").replace(/\D/g, "");

  async function guardar() {
    if (guardando) return;
    setGuardando(true); setError("");
    try {
      let fila;
      if (modo === "existente") {
        if (!elegido) throw new Error("Elige un conductor de la lista");
        const anterior = elegido.telefono && elegido.telefono !== tel
          ? `Tel. anterior: ${elegido.telefono}` : null;
        fila = {
          driver_id: elegido.driver_id,
          nombre: elegido.nombre,
          telefono: tel,
          email: elegido.email || null,
          patente: elegido.patente || null,
          notas: [anterior, "Número tomado de Consultas en ruta"].filter(Boolean).join(" · "),
          origen: "ajuste",
        };
      } else {
        if (!nuevo.nombre.trim()) throw new Error("Escribe el nombre del conductor");
        fila = {
          driver_id: -Date.now(),
          nombre: nuevo.nombre.trim(),
          telefono: tel,
          email: nuevo.email.trim() || null,
          patente: nuevo.patente.trim() || null,
          notas: "Creado desde Consultas en ruta",
          origen: "manual",
        };
      }
      fila.actualizado_en = new Date().toISOString();
      fila.actualizado_por = analistaId || null;
      const { error: e } = await sb.from("crm_directorio_conductores")
        .upsert(fila, { onConflict: "driver_id" });
      if (e) throw new Error(e.message);
      onGuardado(fila.nombre);
    } catch (e) {
      setError(e.message || "No se pudo guardar");
      setGuardando(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 60,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onCerrar}>
      <div style={{ background: "#fff", borderRadius: 12, width: 460, maxWidth: "100%", padding: 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>💾 Guardar en Directorio</div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", marginBottom: 12 }}>
          Número <b>{tel}</b> · aún no está en el Directorio
        </div>

        <div style={{ display: "flex", gap: 5, marginBottom: 12 }}>
          {[{ v: "existente", t: "Asociar a un conductor" }, { v: "nuevo", t: "Crear nuevo" }].map((o) => (
            <button key={o.v} onClick={() => { setModo(o.v); setError(""); }}
              style={{ fontSize: 11.5, padding: "5px 12px", borderRadius: 14, cursor: "pointer",
                border: `1px solid ${modo === o.v ? "var(--naranja)" : "var(--borde)"}`,
                background: modo === o.v ? "var(--naranja-suave)" : "#fff",
                fontWeight: modo === o.v ? 600 : 400 }}>{o.t}</button>
          ))}
        </div>

        {modo === "existente" ? (
          <>
            <input value={q} onChange={(e) => { setQ(e.target.value); setElegido(null); }}
              placeholder="Buscar por nombre o patente…" autoFocus
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
                border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--borde)", borderRadius: 8 }}>
              {q.trim().length < 2 ? (
                <div style={{ padding: 14, fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>
                  Escribe al menos 2 letras del nombre o la patente.
                </div>
              ) : candidatos.length === 0 ? (
                <div style={{ padding: 14, fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>
                  Sin coincidencias. Prueba con "Crear nuevo".
                </div>
              ) : candidatos.map((c) => (
                <div key={c.driver_id} onClick={() => setElegido(c)}
                  style={{ padding: "8px 12px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                    background: elegido?.driver_id === c.driver_id ? "var(--naranja-suave)" : "#fff" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.nombre || "—"}</div>
                  <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                    {c.patente ? c.patente + " · " : ""}{c.telefono ? "tel. actual " + c.telefono : "sin teléfono"}
                  </div>
                </div>
              ))}
            </div>
            {elegido && elegido.telefono && elegido.telefono.replace(/\D/g, "") !== tel && (
              <div style={{ background: "#FAEEDA", color: "#633806", borderRadius: 8, padding: "8px 12px",
                fontSize: 11.5, marginTop: 8 }}>
                {elegido.nombre} ya tiene el teléfono {elegido.telefono}. Se reemplazará por {tel}
                (el anterior queda anotado en el Directorio).
              </div>
            )}
          </>
        ) : (
          <>
            <input value={nuevo.nombre} onChange={(e) => setNuevo((p) => ({ ...p, nombre: e.target.value }))}
              placeholder="Nombre y apellido" autoFocus
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
                border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 6 }} />
            <input value={nuevo.patente} onChange={(e) => setNuevo((p) => ({ ...p, patente: e.target.value }))}
              placeholder="Patente (opcional)"
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
                border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 6 }} />
            <input value={nuevo.email} onChange={(e) => setNuevo((p) => ({ ...p, email: e.target.value }))}
              placeholder="Correo (opcional)"
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
                border: "1px solid var(--borde)", borderRadius: 7 }} />
          </>
        )}

        {error && <div style={{ color: "#791F1F", fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
          <button onClick={guardar}
            disabled={guardando || (modo === "existente" ? !elegido : !nuevo.nombre.trim())}
            style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff",
              border: "none", borderRadius: 7, cursor: "pointer", opacity: guardando ? 0.6 : 1 }}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
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
  const [params, setParams] = useSearchParams();
  const casoParam = params.get("caso");
  const convParam = params.get("conv");
  const convRestaurada = useRef(false);
  const saltoHecho = useRef(false);
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
  // el ticket pertenece a otro analista → toda acción sobre él queda bloqueada
  const ticketDeOtro = !!(ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id);

  // Realtime: si cambia un caso del hilo abierto (toma, traspaso, cierre),
  // recargar el hilo → el candado se alinea solo en todas las pantallas.
  const ticketRef = useRef(null);
  const casosRef = useRef({});
  const [contexto, setContexto] = useState({ nombre: null, sc: null, ruta: null });
  const [guardando, setGuardando] = useState(false);
  const [generandoIA, setGenerandoIA] = useState(false);
  const [avisoPanel, setAvisoPanel] = useState("");
  const leidosRef = useRef(new Set());
  const finRef = useRef(null);
  const hiloRef = useRef(null);          // contenedor con scroll del hilo
  const convVistaRef = useRef(null);     // qué conversación se mostró la última vez
  const selRef = useRef(null);
  selRef.current = sel;

  const aplicarLeidos = useCallback((lista) =>
    lista.map((c) => leidosRef.current.has(c.id) ? { ...c, no_leidos: 0 } : c), []);

  const [nombresLista, setNombresLista] = useState({});
  const cargarConvs = useCallback(async () => {
    try {
      const lista = aplicarLeidos(await listarConversaciones());
      setConvs(lista);
      setNombresLista(await nombresParaLista(lista));
    }
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
        // solo un ticket de CONSULTA puede ser el ticket abierto de esta pestaña;
        // si el hilo fue anidado, su caso es una incidencia y se gestiona allá
        if (ABIERTOS.includes(c.estado_id) && c.origen === "consulta") abierto = c;
      }
    }
    setCasos(mapa);
    setTicketAbierto(abierto);
    setHaySinCaso(msgs.some((m) => !m.case_id && m.direccion === "entrante"));
    const cv = await conversacionPorTelefono(conv.telefono);
    setConversacion(cv);
  }, []);

  ticketRef.current = ticketAbierto;
  casosRef.current = casos;
  useEffect(() => {
    const canal = sb.channel("consultas-casos-vivo")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crm_inc_casos" }, (payload) => {
        const c = payload.new || {};
        const relevante = (ticketRef.current && c.id === ticketRef.current.id) ||
                          (casosRef.current && casosRef.current[c.case_id] !== undefined);
        if (relevante && selRef.current) cargarHilo(selRef.current);
      })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarHilo]);

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
      // event:"*" y no solo INSERT: el worker de adjuntos completa la foto y
      // la transcripción con UPDATEs posteriores (media_path llega ~15 s
      // después del mensaje, la descripción de Vision después). Sin escuchar
      // UPDATE, la imagen quedaba en "en cola de descarga…" hasta refrescar.
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_mensajes", filter: `conversacion_id=eq.${sel.id}` },
        () => { if (selRef.current) cargarHilo(selRef.current); })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [sel, cargarHilo]);

  // Respaldo del Realtime: mientras haya un adjunto sin bajar o sin transcribir,
  // refrescar cada 5 s. Se apaga solo cuando todo maduró (o a los 3 min, por si
  // el worker está caído). Así la foto aparece aunque el evento se pierda.
  useEffect(() => {
    if (!sel || !hayAdjuntoMadurando(mensajes)) return;
    const t = setInterval(() => { if (selRef.current) cargarHilo(selRef.current); }, 5000);
    return () => clearInterval(t);
  }, [sel, mensajes, cargarHilo]);

  // Al abrir una conversación hay que quedar SIEMPRE al final del historial.
  // scrollIntoView con smooth no alcanza: las imágenes y los reproductores de
  // audio cargan después y empujan el contenido hacia abajo, dejando el hilo a
  // media altura. Por eso se mueve el contenedor directo, de golpe, y se repite
  // un par de veces mientras los adjuntos terminan de dibujarse.
  const irAlFinal = useCallback((suave) => {
    const c = hiloRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: suave ? "smooth" : "auto" });
    else finRef.current?.scrollIntoView({ behavior: suave ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    if (!mensajes.length) return;
    const cambioDeConversacion = convVistaRef.current !== sel?.id;
    convVistaRef.current = sel?.id;

    if (cambioDeConversacion) {
      // Recién abierta: al final de inmediato, sin animación, y reintentos
      // cortos para absorber la carga de imágenes y audios.
      irAlFinal(false);
      const t1 = setTimeout(() => irAlFinal(false), 120);
      const t2 = setTimeout(() => irAlFinal(false), 450);
      const t3 = setTimeout(() => irAlFinal(false), 1200);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
    // Mensaje nuevo en la conversación que ya estabas viendo: animado.
    irAlFinal(true);
  }, [mensajes, sel?.id, irAlFinal]);

  // Cuando una imagen o un audio termina de cargar, el alto cambia: si estabas
  // al final, hay que seguir estándolo.
  useEffect(() => {
    const c = hiloRef.current;
    if (!c) return;
    const alCargar = (e) => {
      if (!["IMG", "AUDIO", "VIDEO", "IFRAME"].includes(e.target?.tagName)) return;
      const cerca = c.scrollHeight - c.scrollTop - c.clientHeight < 220;
      if (cerca) irAlFinal(false);
    };
    c.addEventListener("load", alCargar, true);
    c.addEventListener("loadedmetadata", alCargar, true);
    return () => {
      c.removeEventListener("load", alCargar, true);
      c.removeEventListener("loadedmetadata", alCargar, true);
    };
  }, [sel?.id, irAlFinal]);

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
    // La conversación abierta vive en la URL: si el módulo se remonta (F5,
    // deploy, remount), se restaura sola en vez de volver a la lista.
    setParams((prev) => { const np = new URLSearchParams(prev); np.set("conv", conv.id); return np; }, { replace: true });
    setMensajes([]); setCasos({}); setTicketAbierto(null); setHaySinCaso(false);
    try {
      leidosRef.current.add(conv.id);
      setConvs((prev) => prev.map((c) => c.id === conv.id ? { ...c, no_leidos: 0 } : c));
      sb.from("crm_inc_conversaciones").update({ no_leidos: 0 }).eq("id", conv.id).then(() => {});
      await cargarHilo(conv);
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }

  // ── Restauración tras remount: /consultas?conv=<id> reabre la conversación ─
  useEffect(() => {
    if (convRestaurada.current || !convParam || !convs.length || sel) return;
    const conv = convs.find((c) => c.id === convParam);
    if (conv) { convRestaurada.current = true; abrirConv(conv); }
  }, [convParam, convs, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Enlace profundo desde el chat interno: /consultas?caso=900000021 ──────
  // Dos fases, porque el chat solo conoce el case_id y esta pestaña se organiza
  // por conversación y por día: primero se resuelve a qué conversación y a qué
  // fecha pertenece el caso, después se abre cuando la lista de ese día cargó.
  const [convObjetivo, setConvObjetivo] = useState(null);

  useEffect(() => {
    if (!casoParam || saltoHecho.current) return;
    let vivo = true;
    (async () => {
      const { data } = await sb
        .from("crm_inc_mensajes")
        .select("conversacion_id, creado_en")
        .eq("case_id", casoParam)
        .not("conversacion_id", "is", null)
        .order("creado_en", { ascending: true })
        .limit(1);
      if (!vivo) return;
      const fila = data?.[0];
      if (!fila) { saltoHecho.current = true; setParams({}, { replace: true }); return; }
      const dia = new Date(fila.creado_en)
        .toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
      setConvObjetivo(fila.conversacion_id);
      setFechaSel(dia);
    })();
    return () => { vivo = false; };
  }, [casoParam, setParams]);

  useEffect(() => {
    if (!convObjetivo || !convs.length) return;
    const conv = convs.find((c) => c.id === convObjetivo);
    if (!conv) return;
    saltoHecho.current = true;
    setConvObjetivo(null);
    setParams({}, { replace: true });
    abrirConv(conv);
  }, [convObjetivo, convs]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const [modalGuardar, setModalGuardar] = useState(false);
  async function numeroGuardado(nombre) {
    setModalGuardar(false);
    if (sel) {
      setNombresLista((p) => ({ ...p, [sel.telefono]: nombre }));
      await cargarHilo(sel);
    }
  }

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
        .map((m) => `${m.direccion === "entrante" ? "Conductor" : (m.emisor === "ia" ? "IA" : "Analista")}: ${m.texto || m.transcripcion || `[${m.tipo_contenido}]`}`)
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
      if (cid && cambiaTicket && casos[cid]) {
        const c = casos[cid];
        if (c.origen === "meli") {
          // tramo anidado: la conversación se gestiona desde Incidencias
          out.push(<LineaCierre key={`anid-${cid}`} codigo={"Conversación"} anidadoEn={cid} />);
        } else if (!ABIERTOS.includes(c.estado_id)) {
          out.push(<LineaCierre key={`cierre-${cid}`} codigo={c.codigo || "#" + cid}
            anidadoEn={c.anidado_en_case_id || null} />);
        }
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
                <span style={{ fontSize: 13, fontWeight: 500 }}>{c.conductor_nombre || nombresLista[c.telefono] || c.telefono}</span>
                {c.no_leidos > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 600, background: "var(--naranja)",
                    color: "#fff", borderRadius: 10, padding: "1px 7px" }}>{c.no_leidos}</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.ultimo_mensaje_texto || "—"}</div>
              <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 2 }}>{hace(c.ultimo_mensaje_en)}{(c.conductor_nombre || nombresLista[c.telefono]) ? ` · ${c.telefono}` : ""}</div>
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
              <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                {/* El Directorio manda sobre el perfil de WhatsApp: ese nombre lo
                    controla el conductor y puede cambiar cuando quiera. El botón
                    para guardarlo vive en la ficha, no acá, para no romper la línea. */}
                {contexto.nombre || nombresLista[sel.telefono] || sel.conductor_nombre || sel.telefono}
              </div>
              <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
                {sel.telefono}{ticketAbierto ? ` · ${ticketAbierto.codigo || "#" + ticketAbierto.case_id} abierto` : " · sin ticket abierto"}
              </div>
            </div>
            {ticketAbierto && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <BotonCompartirChat caso={ticketAbierto} analistaId={analista?.id} compacto />
                <span className="pill" style={{ background: "#e0e7ff", color: "var(--navy)" }}>
                  {ticketAbierto.codigo || "#" + ticketAbierto.case_id}
                </span>
              </div>
            )}
          </div>

          <div ref={hiloRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)",
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
                  <BotonAdjunto telefono={sel?.telefono} caseId={ticketAbierto?.case_id}
                    conversacionId={sel?.id} disabled={accion || ticketDeOtro}
                    onEnviado={() => cargarHilo(sel)} />
                  <GrabadorAudio telefono={sel?.telefono} caseId={ticketAbierto?.case_id}
                    conversacionId={sel?.id} disabled={accion || ticketDeOtro}
                    onEnviado={() => cargarHilo(sel)} />
                  <input value={texto} onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
                    placeholder={ticketDeOtro
                      ? `Ticket de ${nombresAnalistas[ticketAbierto.analista_actual] || "otro analista"} — traspásatelo para escribir`
                      : "Escribe al conductor…"}
                    disabled={accion || ticketDeOtro} style={{ flex: 1 }} />
                  <button className="btn-navy" onClick={enviar} disabled={accion || !texto.trim() || ticketDeOtro || (ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id)}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>{accion ? "…" : "Enviar"}</button>
                  <button className="btn-naranja" onClick={cerrar} disabled={accion || ticketDeOtro}
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
              <div>
                <span style={{ color: "var(--texto-suave)" }}>Conductor:</span>{" "}
                {contexto.nombre || nombresLista[sel.telefono] || sel.conductor_nombre || "—"}
                {!(contexto.nombre || nombresLista[sel.telefono]) && sel.conductor_nombre && (
                  <span style={{ color: "var(--texto-tenue)", fontSize: 11 }}>
                    {" "}· perfil de WhatsApp
                  </span>
                )}
              </div>
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
                  {ticketAbierto.analista_actual === analista?.id && (
                    <select defaultValue="" onChange={async (e) => {
                      const d = e.target.value; e.target.value = "";
                      if (!d) return;
                      if (!window.confirm(`¿Traspasar el ticket a ${nombresAnalistas[d]}?`)) return;
                      const { error } = await sb.rpc("fn_traspasar_ticket", { p_caso_id: ticketAbierto.id, p_destino: d });
                      if (error) { setAvisoPanel("No se pudo traspasar: " + error.message); return; }
                      if (sel) await cargarHilo(sel);
                    }} style={{ fontSize: 11, padding: "3px 6px", border: "1px solid var(--borde)", borderRadius: 6 }}>
                      <option value="" disabled>↪ Traspasar…</option>
                      {Object.entries(nombresAnalistas).filter(([id]) => id !== analista?.id)
                        .map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                    </select>
                  )}
                </div>
              )}
              {contexto.ruta && <div><span style={{ color: "var(--texto-suave)" }}>Ruta de hoy:</span> {contexto.ruta}</div>}
            </div>

            {ticketAbierto ? (
              <>
                {/* SC */}
                <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>Service Center</div>
                <select value={caract.sc} disabled={ticketDeOtro} onChange={(e) => setCaract((p) => ({ ...p, sc: e.target.value }))}
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
                      <button key={e.id} onClick={() => toggleEtiqueta(e.id)} disabled={ticketDeOtro}
                        style={{ fontSize: 12, padding: "5px 10px", borderRadius: 14, cursor: ticketDeOtro ? "not-allowed" : "pointer", opacity: ticketDeOtro ? 0.55 : 1,
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
                  <button onClick={generarResumen} disabled={generandoIA || mensajes.length === 0 || ticketDeOtro}
                    title="Genera un resumen de la conversación con IA"
                    style={{ fontSize: 11, padding: "3px 10px" }}>
                    {generandoIA ? "Generando…" : "✨ Resumen IA"}
                  </button>
                </div>
                <textarea value={caract.comentarios} disabled={ticketDeOtro}
                  onChange={(e) => setCaract((p) => ({ ...p, comentarios: e.target.value }))}
                  rows={6} placeholder="Qué pasó, qué se gestionó, cómo quedó…"
                  style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: 9, border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />

                {avisoPanel && <div style={{ fontSize: 11, color: avisoPanel.startsWith("No") || avisoPanel.startsWith("IA") ? "#791F1F" : "#15803d", marginTop: 6 }}>{avisoPanel}</div>}

                <button className="btn-navy" onClick={() => guardarCaract(false)} disabled={guardando || ticketDeOtro}
                  style={{ width: "100%", padding: "9px", marginTop: 10 }}>
                  {guardando ? "Guardando…" : "Guardar ficha"}
                </button>

                {/* Directorio: acción distinta de la ficha del ticket (una describe
                    el caso, la otra da identidad permanente al conductor), así que
                    va separada por una línea y con jerarquía visual menor. */}
                <div style={{ borderTop: "1px solid var(--borde)", marginTop: 14, paddingTop: 12 }}>
                  {!(contexto.nombre || nombresLista[sel.telefono]) ? (
                    <>
                      <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginBottom: 7 }}>
                        Este número no está en el Directorio de Bigticket.
                      </div>
                      <button onClick={() => setModalGuardar(true)}
                        style={{ width: "100%", padding: "8px", fontSize: 12.5 }}>
                        💾 Guardar en Directorio
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setModalGuardar(true)}
                      style={{ width: "100%", padding: "7px", fontSize: 12, opacity: 0.8 }}>
                      ✏️ Editar en el Directorio
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--texto-tenue)", background: "var(--fondo)", borderRadius: 8, padding: "10px 12px" }}>
                Toma la consulta para caracterizar el ticket. Al cerrar uno y abrirse otra conversación, se genera un ID nuevo con su propia ficha.
              </div>
            )}
          </div>
        )}
      </div>

      {modalGuardar && sel && (
        <ModalGuardarNumero telefono={sel.telefono} analistaId={analista?.user_id}
          onCerrar={() => setModalGuardar(false)} onGuardado={numeroGuardado} />
      )}
    </div>
  );
}
