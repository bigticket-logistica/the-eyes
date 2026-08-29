import { useState, useEffect, useRef, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { puedeActuar } from "../shared/permisos.js";
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
//   [1] turno del asistente, tareas y conversaciones
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
//
// EL ASISTENTE
//   Mismo patrón que Consultas en la torre, con tablas propias: se prende por
//   un rato, en sombra escribe sin enviar, y lo que promete queda como tarea.
//   La diferencia es que acá el nivel es POR ROL — se puede tener auto para
//   supervisores y sombra para conductores al mismo tiempo.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1a3a6b", naranja: "#F47B20", verde: "#1f7a5c", ladrillo: "#9e3b1b",
  gris: "#8a94a6", grisTenue: "#f4f6f9",
  ia: "#3730a3", iaFondo: "#eef2ff", iaBorde: "#c7d2fe",
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

// ── Turno del asistente ────────────────────────────────────────────────────
// Igual que el turno de Biggy: por tiempo y no un interruptor suelto. Quien lo
// prende antes de salir es quien tendría que acordarse de apagarlo, y si se
// olvida el olvido falla del lado seguro — como máximo queda el rato pedido.
//
// POR ROL Y NO GLOBAL
//   Un supervisor que pregunta un plazo recibe un dato. Un conductor recibe un
//   criterio del que depende que le cobren el producto. Un solo interruptor
//   obligaría a tratarlos igual, y la respuesta correcta es soltarlo donde el
//   riesgo es bajo y mirarlo en sombra donde no.
//
// LO QUE SIGNIFICA CADA NIVEL
//   sombra — escribe el borrador y NO lo envía. Nadie tiene que hacer nada con
//            él; es la ventana a lo que haría, y la única forma de calibrarlo
//            antes de confiarle una conversación con plata en juego.
//   auto   — responde de verdad. Si un analista escribe en el hilo, el
//            asistente no vuelve a hablar sobre ese mensaje.
const MINUTOS_TURNO = [30, 60, 120, 240];

const ROL_TEXTO = {
  conductor: "Conductores",
  supervisor: "Supervisores",
  tercero: "Terceros",
  otro: "Sin identificar",
};

function FilaTurno({ e, onActivar, onApagar, ocupado, puede }) {
  const [abierto, setAbierto] = useState(false);
  const vigente = !!e.vigente;
  const restan = e.minutos_restantes;

  return (
    <div style={{ borderTop: "1px solid var(--borde)" }}>
      <button onClick={() => setAbierto((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%",
          textAlign: "left", background: "transparent", border: "none",
          padding: "6px 10px", cursor: "pointer" }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0,
          background: vigente ? (e.nivel === "auto" ? C.verde : C.ia) : "#d6dce6" }} />
        <span style={{ fontSize: 11.5, fontWeight: 600,
          color: vigente ? "var(--texto)" : "var(--texto-tenue)" }}>
          {ROL_TEXTO[e.rol] || e.rol}
        </span>
        {vigente && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff",
            background: e.nivel === "auto" ? C.verde : C.ia, borderRadius: 9,
            padding: "1px 6px" }}>
            {e.nivel}
          </span>
        )}
        {vigente && restan != null && (
          <span style={{ fontSize: 9.5, color: restan <= 5 ? C.ladrillo : "var(--texto-suave)",
            fontWeight: restan <= 5 ? 700 : 500 }}>
            {restan} min
          </span>
        )}
        {/* Activo pero fuera de la ventana horaria: el estado real es que no
            está respondiendo, y decirlo evita que alguien lo dé por prendido. */}
        {e.activo && !vigente && (
          <span style={{ fontSize: 9.5, color: C.ladrillo }}>fuera de horario</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--texto-tenue)" }}>
          {abierto ? "▲" : "▼"}
        </span>
      </button>

      {abierto && (
        <div style={{ padding: "0 10px 8px 24px" }}>
          <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", lineHeight: 1.4,
            marginBottom: 5 }}>
            Responde entre las {e.ventana_desde}:00 y las {e.ventana_hasta}:00 CDMX,
            {" "}después de {e.espera_seg} s de espera.
            {vigente && e.activado_por ? ` Lo activó ${e.activado_por}.` : ""}
          </div>

          {!puede ? (
            <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", fontStyle: "italic" }}>
              Tu usuario es de solo lectura.
            </div>
          ) : e.activo ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <button onClick={() => onApagar(e.rol)} disabled={ocupado}
                style={{ fontSize: 10, padding: "3px 9px" }}>
                ⏹ Apagar
              </button>
              {MINUTOS_TURNO.map((m) => (
                <button key={m} onClick={() => onActivar(e.rol, m, e.nivel)} disabled={ocupado}
                  title={`Extender a ${m} minutos desde ahora, en ${e.nivel}`}
                  style={{ fontSize: 10, padding: "3px 7px" }}>
                  +{m}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", marginBottom: 3 }}>
                Escribe el borrador y no lo envía:
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                {MINUTOS_TURNO.map((m) => (
                  <button key={m} onClick={() => onActivar(e.rol, m, "sombra")} disabled={ocupado}
                    style={{ fontSize: 10, padding: "3px 8px" }}>
                    {m} min en sombra
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 9.5, color: C.ladrillo, marginBottom: 3 }}>
                Responde de verdad:
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[30, 60].map((m) => (
                  <button key={m} className="btn-navy"
                    onClick={() => onActivar(e.rol, m, "auto")} disabled={ocupado}
                    style={{ fontSize: 10, padding: "3px 9px" }}>
                    {m} min en auto
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PanelAsistente({ estado, onActivar, onApagar, ocupado, puede, onRefrescar }) {
  const [abierto, setAbierto] = useState(false);
  const vigentes = estado.filter((e) => e.vigente);
  const hayAuto = vigentes.some((e) => e.nivel === "auto");

  return (
    <div style={{ marginBottom: 8, borderRadius: 10, overflow: "hidden",
      border: `1px solid ${vigentes.length ? C.iaBorde : "var(--borde)"}`,
      background: vigentes.length ? C.iaFondo : "#fff" }}>
      <button onClick={() => setAbierto((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%",
          textAlign: "left", background: "transparent", border: "none",
          padding: "8px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 13 }}>🤖</span>
        <span style={{ fontSize: 12, fontWeight: 600,
          color: vigentes.length ? C.ia : "var(--texto-suave)" }}>
          {vigentes.length === 0
            ? "Asistente apagado"
            : `Asistente en ${vigentes.map((e) => ROL_TEXTO[e.rol]?.toLowerCase() || e.rol).join(", ")}`}
        </span>
        {hayAuto && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff",
            background: C.verde, borderRadius: 9, padding: "1px 6px" }}>
            enviando
          </span>
        )}
        <span role="button" tabIndex={0} title="Actualizar ahora"
          onClick={(ev) => { ev.stopPropagation(); onRefrescar?.(); }}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.stopPropagation(); onRefrescar?.(); } }}
          style={{ marginLeft: "auto", fontSize: 11, color: C.ia, cursor: "pointer",
            padding: "0 2px" }}>↻</span>
        <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
          {abierto ? "▲" : "▼"}
        </span>
      </button>

      {abierto && (
        <div>
          {estado.length === 0 ? (
            <div style={{ padding: "7px 10px", fontSize: 10.5, color: "var(--texto-tenue)",
              borderTop: "1px solid var(--borde)" }}>
              Sin configuración. Corre la migración del asistente.
            </div>
          ) : (
            estado.map((e) => (
              <FilaTurno key={e.rol} e={e} onActivar={onActivar} onApagar={onApagar}
                ocupado={ocupado} puede={puede} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Tareas que dejó el asistente ───────────────────────────────────────────
// El asistente no carga comprobantes en MELI, no llama y no decide si una
// evidencia sirve. Cuando ofrece que la torre lo gestione, deja la tarea acá.
//
// Una promesa sin tarea es peor que no ofrecer nada: la persona queda esperando
// algo que nunca va a llegar, y la próxima vez ya no escribe.
const TIPO_TAREA = {
  revisar_evidencia:  { icono: "🔍", texto: "revisar evidencia" },
  cargar_comprobante: { icono: "📤", texto: "cargar comprobante en MELI" },
  avisar_supervisor:  { icono: "✉️", texto: "avisar al supervisor" },
  confirmar_estado:   { icono: "❓", texto: "confirmar un dato" },
  llamar:             { icono: "📞", texto: "llamar" },
  seguimiento:        { icono: "🔁", texto: "seguimiento" },
  otro:               { icono: "📌", texto: "pendiente" },
};

function BloqueTareas({ tareas, cargando, onResolver, onAbrirChat, onRefrescar, puede }) {
  // Abierto por defecto cuando hay tareas: son compromisos que el asistente ya
  // comunicó, así que esperan a alguien. Cerrado las esconde justo cuando
  // importan.
  const [abierto, setAbierto] = useState(true);
  if (!cargando && tareas.length === 0) return null;

  return (
    <div style={{ marginBottom: 8, border: `1px solid ${C.iaBorde}`, borderRadius: 10,
      background: C.iaFondo, overflow: "hidden" }}>
      <button onClick={() => setAbierto((v) => !v)}
        title="Cosas que el asistente prometió y hay que cumplir"
        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%",
          textAlign: "left", background: "transparent", border: "none",
          padding: "8px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 11, color: C.ia,
          transform: abierto ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.ia }}>
          Tareas pendientes
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#fff",
          background: "#4338ca", borderRadius: 9, padding: "1px 7px", minWidth: 18,
          textAlign: "center" }}>
          {cargando ? "…" : tareas.length}
        </span>
        <span role="button" tabIndex={0} title="Actualizar ahora"
          onClick={(ev) => { ev.stopPropagation(); onRefrescar?.(); }}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.stopPropagation(); onRefrescar?.(); } }}
          style={{ fontSize: 11, color: C.ia, cursor: "pointer", padding: "0 2px" }}>↻</span>
      </button>

      {abierto && (
        <div style={{ maxHeight: 260, overflowY: "auto", borderTop: `1px solid ${C.iaBorde}` }}>
          <div style={{ fontSize: 10, color: C.ia, padding: "6px 10px", lineHeight: 1.35 }}>
            El asistente ya dijo que la torre lo iba a gestionar.
          </div>
          {tareas.map((t) => {
            const meta = TIPO_TAREA[t.tipo] || TIPO_TAREA.otro;
            return (
              <div key={t.id} style={{ padding: "7px 10px", borderTop: "1px solid #e0e7ff",
                background: "#fff" }}>
                <div style={{ display: "flex", gap: 5, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12 }}>{meta.icono}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{meta.texto}</span>
                  <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
                    {hace(t.creada_en)}
                  </span>
                </div>
                <div style={{ fontSize: 11, marginTop: 2, lineHeight: 1.35 }}>{t.detalle}</div>
                <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginTop: 1 }}>
                  {t.conductor || t.telefono || "sin nombre"}
                  {t.case_id ? ` · caso ${t.case_id}` : ""}
                </div>
                {puede && (
                  <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                    {t.conversacion_id && (
                      <button onClick={() => onAbrirChat(t)}
                        style={{ fontSize: 10.5, padding: "3px 9px" }}>
                        abrir chat
                      </button>
                    )}
                    <button onClick={() => onResolver(t, "hecha")}
                      style={{ fontSize: 10.5, padding: "3px 9px" }}>
                      ✓ hecha
                    </button>
                    <button onClick={() => onResolver(t, "descartada")}
                      style={{ fontSize: 10.5, padding: "3px 9px" }}>
                      descartar
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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

// ── Burbuja de borrador ────────────────────────────────────────────────────
// Un borrador NO es un mensaje pendiente de enviar: es lo que el asistente
// habría contestado. La persona no recibió nada. Por eso va con otro borde,
// alineado al centro y rotulado — mostrarlo como una burbuja saliente normal
// haría dudar de si algo salió.
//
// Los dos botones son lo único que convierte el sombra en información: sin
// alguien que diga si servía, a las dos semanas no hay con qué decidir si se
// puede soltar en auto.

function BurbujaBorrador({ d, onRevisar, puede }) {
  const [ocupado, setOcupado] = useState(false);

  async function marcar(aprobado) {
    setOcupado(true);
    await onRevisar(d, aprobado);
    setOcupado(false);
  }

  return (
    <div style={{ alignSelf: "center", maxWidth: "82%", width: "100%",
      border: `1px dashed ${C.iaBorde}`, borderRadius: 10, background: C.iaFondo,
      padding: "8px 11px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3,
        flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.ia }}>
          🤖 BORRADOR · no se envió
        </span>
        {d.escalado && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: C.ladrillo,
            background: "#faece6", borderRadius: 4, padding: "1px 5px" }}>
            escaló
          </span>
        )}
        {d.intencion && (
          <span style={{ fontSize: 9.5, color: "var(--texto-suave)" }}>{d.intencion}</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--texto-tenue)" }}>
          {hora(d.creado_en)}
        </span>
      </div>

      <div style={{ fontSize: 12.5, lineHeight: 1.45, whiteSpace: "pre-wrap",
        color: "var(--texto)" }}>
        {d.respuesta || d.motivo_escalado || "(sin texto)"}
      </div>

      {d.error && (
        <div style={{ fontSize: 10, color: C.ladrillo, marginTop: 4 }}>
          error: {d.error}
        </div>
      )}

      <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 6,
        flexWrap: "wrap" }}>
        {d.aprobado === true && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: C.verde }}>✓ servía</span>
        )}
        {d.aprobado === false && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: C.ladrillo }}>✗ no servía</span>
        )}
        {puede && d.aprobado == null && (
          <>
            <button onClick={() => marcar(true)} disabled={ocupado}
              title="Lo habría enviado tal cual"
              style={{ fontSize: 10, padding: "2px 8px" }}>
              servía
            </button>
            <button onClick={() => marcar(false)} disabled={ocupado}
              title="No lo habría enviado"
              style={{ fontSize: 10, padding: "2px 8px" }}>
              no servía
            </button>
          </>
        )}
        {d.latencia_ms != null && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--texto-tenue)" }}>
            {(d.latencia_ms / 1000).toFixed(1)} s
          </span>
        )}
      </div>
    </div>
  );
}

// ── Módulo ─────────────────────────────────────────────────────────────────

export default function ChatPosventa() {
  const { analista } = useAuth();
  const puede = puedeActuar(analista);
  const esAdmin = analista?.rol === "admin";

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

  // ── Turno del asistente ──────────────────────────────────────────────────
  // Cada 30 s porque la cuenta regresiva avanza sola y porque otro analista
  // puede prenderlo o apagarlo desde su pantalla.
  const [turnos, setTurnos] = useState([]);
  const [turnoOcupado, setTurnoOcupado] = useState(false);
  const cargarTurnos = useCallback(async () => {
    const { data, error: e } = await sb.rpc("fn_pnr_asistente_estado");
    if (!e) setTurnos(Array.isArray(data) ? data : []);
  }, []);
  useEffect(() => {
    cargarTurnos();
    const t = setInterval(cargarTurnos, 30000);
    return () => clearInterval(t);
  }, [cargarTurnos]);

  async function activarTurno(rol, minutos, nivel) {
    setTurnoOcupado(true);
    const { error: e } = await sb.rpc("fn_pnr_asistente_turno",
      { p_rol: rol, p_minutos: minutos, p_nivel: nivel });
    setTurnoOcupado(false);
    if (e) { setError("No se pudo activar: " + e.message); return; }
    await cargarTurnos();
  }

  async function apagarTurno(rol) {
    setTurnoOcupado(true);
    const { error: e } = await sb.rpc("fn_pnr_asistente_turno",
      { p_rol: rol, p_minutos: null, p_nivel: "sombra" });
    setTurnoOcupado(false);
    if (e) { setError("No se pudo apagar: " + e.message); return; }
    await cargarTurnos();
  }

  // ── Tareas ───────────────────────────────────────────────────────────────
  const [tareas, setTareas] = useState([]);
  const [cargandoTareas, setCargandoTareas] = useState(true);
  const cargarTareas = useCallback(async () => {
    setCargandoTareas(true);
    const { data, error: e } = await sb.from("pnr_asistente_tareas")
      .select("*").eq("estado", "pendiente")
      .order("creada_en", { ascending: false }).limit(50);
    setTareas(e ? [] : (data || []));
    setCargandoTareas(false);
  }, []);
  useEffect(() => {
    cargarTareas();
    const t = setInterval(cargarTareas, 60000);
    return () => clearInterval(t);
  }, [cargarTareas]);

  async function resolverTarea(t, estado) {
    // Se pide nota solo al descartar: si ya no aplica, conviene saber por qué —
    // es la señal de que el asistente promete cosas que no correspondían.
    let nota = null;
    if (estado === "descartada") {
      nota = window.prompt("¿Por qué ya no aplica?", "");
      if (nota === null) return;
    }
    const { error: e } = await sb.rpc("fn_pnr_asistente_tarea_resolver",
      { p_id: t.id, p_estado: estado, p_nota: nota || null });
    if (e) { setError("No se pudo actualizar: " + e.message); return; }
    await cargarTareas();
  }

  // ── Borradores ───────────────────────────────────────────────────────────
  // Solo para admin, igual que en Consultas: en el hilo de un analista son
  // ruido —tapan lo que dijo el conductor y hacen dudar de si algo se envió— y
  // nadie tiene que hacer nada con ellos. Quedan disponibles porque son la
  // única ventana a lo que el asistente haría.
  const [verBorradores, setVerBorradores] = useState(false);
  const [borradores, setBorradores] = useState([]);

  const cargarBorradores = useCallback(async (convId) => {
    if (!convId) { setBorradores([]); return; }
    const { data, error: e } = await sb.from("pnr_asistente_decisiones")
      .select("*").eq("conversacion_id", convId)
      .eq("enviado", false)
      .order("creado_en", { ascending: true }).limit(200);
    setBorradores(e ? [] : (data || []));
  }, []);

  useEffect(() => {
    if (verBorradores && sel) cargarBorradores(sel.id);
    else setBorradores([]);
  }, [verBorradores, sel, cargarBorradores]);

  async function revisarBorrador(d, aprobado) {
    const { error: e } = await sb.rpc("fn_pnr_asistente_revisar",
      { p_id: d.id, p_aprobado: aprobado, p_texto: null });
    if (e) { setError("No se pudo guardar la revisión: " + e.message); return; }
    setBorradores((prev) => prev.map((x) => x.id === d.id ? { ...x, aprobado } : x));
  }

  // ── Conversaciones e hilo ────────────────────────────────────────────────

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

  // Realtime de las decisiones: en sombra el borrador aparece medio minuto
  // después del mensaje, y sin esto habría que reabrir el hilo para verlo —
  // que es justo el momento en que se está mirando cómo responde.
  useEffect(() => {
    if (!verBorradores || !sel) return;
    const canal = sb.channel("pnr-asistente-dec")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pnr_asistente_decisiones" },
        (payload) => {
          const d = payload.new;
          if (!d || d.conversacion_id !== sel.id) return;
          cargarBorradores(sel.id);
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [verBorradores, sel, cargarBorradores]);

  // Bajar al último mensaje. Va después de pintar para que la altura ya esté
  // calculada; con scroll inmediato queda a media altura.
  useEffect(() => {
    const t = setTimeout(() => {
      if (hiloRef.current) hiloRef.current.scrollTop = hiloRef.current.scrollHeight;
    }, 60);
    return () => clearTimeout(t);
  }, [mensajes, borradores]);

  function abrir(conv) {
    setSel(conv);
    setMensajes([]);
    setError(null);
    cargarHilo(conv);
  }

  function abrirDesdeTarea(t) {
    const conv = convs.find((c) => c.id === t.conversacion_id);
    if (conv) abrir(conv);
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

  // Estado del asistente para el rol de la conversación abierta. Se muestra en
  // el encabezado porque cambia lo que significa el silencio: en auto, que no
  // haya respuesta es un problema; apagado, es lo esperado.
  const turnoSel = sel ? turnos.find((t) => t.rol === sel.rol) : null;

  // El hilo mezcla mensajes y borradores por hora. Se ordena una sola vez acá
  // en vez de intercalar al pintar: un borrador tiene que quedar justo debajo
  // del mensaje que lo provocó, y ese orden es cronológico.
  const hilo = verBorradores
    ? [
        ...mensajes.map((m) => ({ clase: "msg", en: m.creado_en, id: `m${m.id}`, dato: m })),
        ...borradores.map((d) => ({ clase: "borr", en: d.creado_en, id: `d${d.id}`, dato: d })),
      ].sort((a, b) => new Date(a.en) - new Date(b.en))
    : mensajes.map((m) => ({ clase: "msg", en: m.creado_en, id: `m${m.id}`, dato: m }));

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, gap: 12 }}>

      {/* ── Columna izquierda ───────────────────────────────────────────── */}
      <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column",
        minHeight: 0 }}>

        <PanelAsistente estado={turnos} onActivar={activarTurno} onApagar={apagarTurno}
          ocupado={turnoOcupado} puede={puede} onRefrescar={cargarTurnos} />

        <BloqueTareas tareas={tareas} cargando={cargandoTareas} onResolver={resolverTarea}
          onAbrirChat={abrirDesdeTarea} onRefrescar={cargarTareas} puede={puede} />

        {/* ── Bandeja ──────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
          border: "1px solid var(--borde)", borderRadius: 12, background: "#fff",
          overflow: "hidden" }}>
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
                {sel.rol && sel.rol !== "conductor" && (
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: C.navy,
                    background: "#e4ebf5", borderRadius: 4, padding: "1px 6px",
                    textTransform: "uppercase", letterSpacing: 0.3 }}>
                    {sel.rol}
                  </span>
                )}
                {turnoSel?.vigente && (
                  <span title={turnoSel.nivel === "auto"
                      ? "El asistente está respondiendo a este rol"
                      : "El asistente escribe borradores para este rol y no los envía"}
                    style={{ fontSize: 9.5, fontWeight: 700, color: "#fff",
                      background: turnoSel.nivel === "auto" ? C.verde : C.ia,
                      borderRadius: 4, padding: "1px 6px" }}>
                    🤖 {turnoSel.nivel}
                  </span>
                )}

                {esAdmin && (
                  <label title="Los borradores son lo que el asistente respondería. No se envían."
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5,
                      color: "var(--texto-suave)", cursor: "pointer", whiteSpace: "nowrap",
                      marginLeft: "auto", flexShrink: 0 }}>
                    <input type="checkbox" checked={verBorradores}
                      onChange={(e) => setVerBorradores(e.target.checked)}
                      style={{ width: "auto", margin: 0 }} />
                    🤖 borradores
                  </label>
                )}

                <span style={{ marginLeft: esAdmin ? 0 : "auto", fontSize: 10.5,
                  color: abierta ? C.verde : C.ladrillo }}>
                  {abierta ? `ventana abierta · ${Math.floor(quedan)} h` : "ventana cerrada"}
                </span>
              </div>

            </div>

            <div ref={hiloRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16,
              background: "var(--fondo, #f4f6f9)", display: "flex", flexDirection: "column", gap: 8 }}>
              {hilo.length === 0 ? (
                <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)" }}>
                  Sin mensajes
                </div>
              ) : (
                hilo.map((x) => x.clase === "msg"
                  ? <BurbujaPnr key={x.id} m={x.dato} />
                  : <BurbujaBorrador key={x.id} d={x.dato} onRevisar={revisarBorrador}
                      puede={puede} />)
              )}
              {verBorradores && borradores.length === 0 && mensajes.length > 0 && (
                <div style={{ alignSelf: "center", fontSize: 10, color: "var(--texto-tenue)",
                  fontStyle: "italic" }}>
                  Sin borradores en esta conversación
                </div>
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
