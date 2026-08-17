import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { puedeActuar, esObservador } from "../shared/permisos.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora, diaMX } from "../shared/fechas.js";
import { listarConversaciones, mensajesDeConversacion, crearCasoConsulta, conversacionPorTelefono, ventanaAbierta, enviarMensaje, resumenIA, consultarPaquete, consultarRuta } from "../shared/mensajes.js";
import { useAlertas } from "../shared/alertas.jsx";
import { ETIQUETAS_CASO, SERVICE_CENTERS_MX } from "../shared/constantes.js";
import Burbuja from "../componentes/Burbuja.jsx";
import BotonCompartirChat from "../componentes/BotonCompartirChat.jsx";
import BotonAdjunto from "../componentes/BotonAdjunto.jsx";
import NuevoMensaje from "../componentes/NuevoMensaje.jsx";
import GrabadorAudio from "../componentes/GrabadorAudio.jsx";
import SelectorEmoji from "../componentes/SelectorEmoji.jsx";
import BotonLlamar from "../componentes/BotonLlamar.jsx";
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

// Solo la hora, para el sello del separador de cierre: fechaHora trae la fecha
// completa y en el hilo de un día sobra.
const hora = (t) => {
  try {
    return new Date(t).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};

function LineaCierre({ codigo, anidadoEn, caso, analistaId, onReabrir, cerradoPor, onDeshacer, movidos }) {
  const color = anidadoEn ? "#1a3a6b" : "#16a34a";
  // Quién cerró y a qué hora, en la propia línea. Sin el sello no se podía
  // saber si un mensaje de arriba llegó antes o después del cierre.
  const cuando = caso?.resuelto_en || caso?.cierre_local_en || null;
  const sello = [cerradoPor, cuando ? hora(cuando) : null].filter(Boolean).join(" · ");
  const texto = anidadoEn
    ? `↩ ${codigo} anidado en la incidencia #${anidadoEn}`
    : `✓ ${codigo} resuelto${sello ? ` · ${sello}` : ""}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
      <div style={{ flex: 1, height: 2, background: color, opacity: 0.45 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: anidadoEn ? "#1a3a6b" : "#15803d", whiteSpace: "nowrap" }}>{texto}</span>
      {/* Un ticket cerrado seguía siendo un callejón sin salida: no se podía
          reabrir ni compartir su historial. Reabrir evita partir un mismo
          problema en dos tickets; compartir le da el contexto a quien retoma. */}
      {caso && !anidadoEn && (
        <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flexShrink: 0 }}>
          <BotonCompartirChat caso={caso} analistaId={analistaId} compacto />
          {/* Si esta línea se bajó a mano, se puede devolver. Reversible siempre:
              bajarla de más enterraría una consulta nueva en un ticket cerrado
              que nadie va a volver a mirar. */}
          {onDeshacer && movidos > 0 && (
            <button onClick={() => onDeshacer(caso)}
              title="Devolver los mensajes que se incluyeron al cerrar aquí"
              style={{ fontSize: 10.5, padding: "3px 8px", marginRight: 4 }}>
              ↰ devolver {movidos}
            </button>
          )}
          {onReabrir && (
            <button onClick={() => onReabrir(caso)}
              title="Reabrir este ticket: el cronómetro vuelve a correr"
              style={{ fontSize: 10.5, padding: "2px 8px", whiteSpace: "nowrap" }}>
              ↺ Reabrir
            </button>
          )}
        </span>
      )}
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


// ── Turno de Biggy ──────────────────────────────────────────────────────────
// Para cubrir la colación, el baño o una emergencia: durante ese rato tiene que
// haber alguien respondiendo con la misma certeza, y hoy eso se pierde.
//
// POR TIEMPO Y NO UN INTERRUPTOR SUELTO
//   Quien lo activa antes de salir es quien tendría que acordarse de apagarlo.
//   Si se olvida, Biggy queda autónomo sin nadie mirándolo — la supervisión más
//   baja justo cuando el riesgo es más alto. Con vencimiento, el olvido falla
//   del lado seguro: como máximo queda el rato que se pidió.
//
// TRANSPARENCIA EN VEZ DE PERMISO
//   Lo activa la analista, sin pedirle autorización a nadie: nadie va a pedir
//   permiso para ir al baño. Pero queda registrado quién, cuándo y cuánto en
//   biggy_turnos. Un analista que prende Biggy tres horas al día no es un
//   analista eficiente, y eso se ve sin que nadie tenga que vigilarlo.
const MINUTOS_TURNO = [30, 45, 60, 90];

function TurnoBiggy({ estado, onActivar, onApagar, ocupado, puede }) {
  const [abierto, setAbierto] = useState(false);
  const activo = !!estado?.activo;
  const restan = estado?.minutos_restantes;

  return (
    <div style={{ marginBottom: 8, borderRadius: 9, overflow: "hidden",
      border: `1px solid ${activo ? "#c7d2fe" : "var(--borde)"}`,
      background: activo ? "#eef2ff" : "#f8fafc" }}>
      <button onClick={() => setAbierto((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%",
          textAlign: "left", background: "transparent", border: "none",
          padding: "8px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 13 }}>🤖</span>
        <span style={{ fontSize: 12, fontWeight: 600,
          color: activo ? "#3730a3" : "var(--texto-suave)" }}>
          {activo ? `Biggy activo · ${estado.nivel}` : "Biggy apagado"}
        </span>
        {activo && restan != null && (
          <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#fff",
            background: restan <= 5 ? "#b45309" : "#4338ca", borderRadius: 9,
            padding: "1px 7px" }}>
            {restan} min
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--texto-tenue)",
          marginLeft: activo && restan != null ? 4 : "auto" }}>
          {abierto ? "▲" : "▼"}
        </span>
      </button>

      {abierto && (
        <div style={{ padding: "0 10px 9px", borderTop: "1px solid var(--borde)" }}>
          {activo ? (
            <>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)", padding: "7px 0 6px",
                lineHeight: 1.4 }}>
                Lo activó <b>{estado.activado_por || "alguien"}</b>.
                {restan != null && ` Se apaga solo en ${restan} minuto${restan === 1 ? "" : "s"}.`}
                {" "}Si tomas un ticket, Biggy no interviene en él.
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {puede && (
                  <button onClick={onApagar} disabled={ocupado}
                    style={{ fontSize: 11, padding: "5px 11px" }}>
                    ⏹ Apagar ahora
                  </button>
                )}
                {puede && MINUTOS_TURNO.map((m) => (
                  <button key={m} onClick={() => onActivar(m, estado.nivel)} disabled={ocupado}
                    title={`Extender el turno a ${m} minutos desde ahora`}
                    style={{ fontSize: 11, padding: "5px 9px" }}>
                    +{m}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)", padding: "7px 0 6px",
                lineHeight: 1.4 }}>
                Actívalo para tu colación o una salida. Se apaga solo al vencer, y
                queda registrado quién lo activó y por cuánto.
              </div>
              {!puede ? (
                <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", fontStyle: "italic" }}>
                  Tu usuario es de solo lectura.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginBottom: 3 }}>
                    Responde de verdad al conductor:
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7 }}>
                    {MINUTOS_TURNO.map((m) => (
                      <button key={m} className="btn-navy" onClick={() => onActivar(m, "auto")}
                        disabled={ocupado} style={{ fontSize: 11, padding: "5px 11px" }}>
                        {m} min
                      </button>
                    ))}
                  </div>
                  {/* Sombra: escribe el borrador y no lo envía. Sirve para ver qué
                      habría contestado antes de confiarle la conversación. */}
                  <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginBottom: 3 }}>
                    Solo prueba, sin enviar nada:
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {[30, 60].map((m) => (
                      <button key={m} onClick={() => onActivar(m, "sombra")} disabled={ocupado}
                        style={{ fontSize: 11, padding: "5px 9px" }}>
                        {m} min en sombra
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}


// ── Mover la línea de cierre ────────────────────────────────────────────────
// El problema: la analista cierra el ticket, el conductor dice "gracias", y ese
// mensaje queda sin ticket. Al tomarlo nace un BT- que vive 30 segundos.
// Medido: 44 en una semana, 32 s de promedio, arrastrando la mediana de tiempo
// de cierre que se mira en Salud.
//
// La solución no es automática: la analista decide. Baja la línea de cierre
// hasta donde quiere, y lo que queda arriba entra al ticket que ya cerró.
//
// Por qué hasta un mensaje ELEGIDO y no todo el bloque: el caso real es
//     "Gracias"                      ← esto entra
//     "tengo otra consulta 4771…"    ← esto NO, es un ticket nuevo
// Mover en bloque enterraría la consulta nueva en un ticket cerrado.
//
// resuelto_en no cambia: la gestión terminó cuando ella respondió y un
// agradecimiento no es tiempo de trabajo. Si mover la línea le empeorara el
// número, no lo haría nunca y volveríamos a los tickets de 32 segundos.
function CerrarAqui({ onMover, moviendo }) {
  const [encima, setEncima] = useState(false);
  return (
    <div onMouseEnter={() => setEncima(true)} onMouseLeave={() => setEncima(false)}
      onClick={onMover}
      title="Bajar el cierre del ticket hasta este mensaje"
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
        padding: "2px 0", opacity: encima ? 1 : 0.28, transition: "opacity .12s" }}>
      <div style={{ flex: 1, height: 1, background: "#16a34a" }} />
      <span style={{ fontSize: 9.5, color: "#16a34a", whiteSpace: "nowrap", fontWeight: 600 }}>
        {moviendo ? "moviendo…" : "— cerrar aquí —"}
      </span>
      <div style={{ flex: 1, height: 1, background: "#16a34a" }} />
    </div>
  );
}


// ── Aviso de ticket en la fila de la lista ─────────────────────────────────
// Lo que hay que ver SIN abrir la conversación: si el ticket está sin tomar y
// cuánto lleva el conductor esperando respuesta.
//
// Los umbrales son de minutos, no de horas. En Salud el ámbar está en 2 h y el
// rojo en 8, pero eso mide tickets; acá mide a una persona esperando en
// WhatsApp mientras maneja. Biggy tiene 60 s de espera configurados y avisa a
// los 1.5 min, así que 5 minutos ya es mucho y 15 es un problema.
const ESPERA_AMBAR = 5;
const ESPERA_ROJA = 15;

// Un borrador de Biggy NO es un mensaje pendiente de enviar: es la simulación
// de lo que Biggy respondería si estuviera activo. Nadie debe hacer nada con
// él, así que mostrarlo como aviso lo hace parecer una tarea — y una etiqueta
// que parece tarea sin serlo enseña a ignorar las etiquetas.
//
// Se deja el interruptor porque el día que exista el botón "Enviar borrador"
// (con captura del diff humano, la única forma de medir si Biggy acierta), el
// borrador SÍ pasa a ser algo que una persona revisa y envía. Ese día esto va
// a true y el aviso vuelve, sin tocar nada más.
//
// Ojo: esto no afecta el reloj. El conductor no recibió nada, haya borrador o
// no, así que la espera se cuenta igual.
const MOSTRAR_BORRADOR = false;

function textoEspera(m) {
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return `${h} h ${String(r).padStart(2, "0")}`;
}

function Chip({ c }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 600, padding: "1px 6px", borderRadius: 9,
      background: c.fondo, border: `1px solid ${c.borde}`, color: c.color,
      maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {c.texto}
    </span>
  );
}

function AvisoTicket({ e }) {
  if (!e) return null;
  const min = e.espera_min == null ? null : Number(e.espera_min);
  const color = min == null ? "var(--texto-tenue)"
    : min >= ESPERA_ROJA ? "#b91c1c"
    : min >= ESPERA_AMBAR ? "#b45309"
    : "var(--texto-suave)";

  // El ticket puede ser una incidencia de MELI: se dice, porque se gestiona en
  // la otra pestaña. Marcarlo "Sin ticket" hacía parecer que nadie lo tenía.
  const esInc = e.origen === "meli";
  const cerrado = e.cerrado_codigo || (e.cerrado_case_id ? `#${e.cerrado_case_id}` : null);

  let chip = null;
  if (e.sin_tomar) {
    chip = { texto: esInc ? `Incidencia sin tomar` : "Sin tomar",
             fondo: "#fef2f2", borde: "#fca5a5", color: "#b91c1c" };
  } else if (e.caso_id && e.es_ia) {
    chip = { texto: `🤖 ${e.analista_nombre || "Biggy"}`,
             fondo: "#eef2ff", borde: "#c7d2fe", color: "#3730a3" };
  } else if (e.caso_id) {
    chip = { texto: esInc ? `Inc · ${e.analista_nombre || "tomado"}` : (e.analista_nombre || "tomado"),
             fondo: "#f0fdf4", borde: "#bbf7d0", color: "#15803d" };
  } else if (e.esperando) {
    // Sin ticket abierto y con algo pendiente: hay que tomar uno. Se distingue
    // si antes hubo uno cerrado, porque no es lo mismo una conversación que
    // nadie tomó nunca que una resuelta a la que llegó un mensaje nuevo.
    chip = cerrado
      ? { texto: "Mensaje nuevo sin ticket", fondo: "#fef2f2", borde: "#fca5a5", color: "#b91c1c" }
      : { texto: "Sin ticket", fondo: "#fef2f2", borde: "#fca5a5", color: "#b91c1c" };
  } else if (cerrado) {
    // Atendida y resuelta. Antes esto compartía etiqueta con "sin ticket", que
    // decía exactamente lo contrario de la verdad.
    chip = { texto: `✓ ${cerrado} cerrado`, fondo: "#f8fafc", borde: "#e2e8f0",
             color: "var(--texto-suave)" };
  }

  const borr = (MOSTRAR_BORRADOR && e.hay_borrador)
    ? { texto: "✍ Borrador por revisar", fondo: "#fffbeb", borde: "#fde68a", color: "#92400e" }
    : null;

  if (!chip && !borr && min == null) return null;

  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginTop: 3 }}>
      {chip && <Chip c={chip} />}
      {borr && <Chip c={borr} />}
      {min != null && (
        <span style={{ fontSize: 9.5, fontWeight: min >= ESPERA_AMBAR ? 600 : 500, color }}
          title="Desde el último mensaje del conductor sin respuesta enviada. Un borrador no cuenta como respuesta: el conductor no lo recibió.">
          ⏱ {textoEspera(min)} sin respuesta
        </span>
      )}
    </div>
  );
}


// ── Tareas que dejó Biggy ───────────────────────────────────────────────────
// Biggy no puede enviar correos ni llamar. Cuando ofrece que la torre gestione
// el contacto —lo correcto según el procedimiento— deja la tarea acá.
//
// El 17-ago dijo a un conductor "voy a dejarle mensaje y correo a Coreisy… te
// aviso si tenemos respuesta" y nadie lo hizo: el conductor quedó esperando algo
// que nunca iba a llegar. Una promesa sin tarea es peor que no ofrecer nada.
//
// Se eligió cola en vez de automatizar el correo: redactar un correo a un
// cliente final de MELI sin supervisión expone la marca de MELI, y hoy no hay
// forma de medir si esos correos funcionan.
const TIPO_TAREA = {
  correo: { icono: "✉️", texto: "enviar correo" },
  llamar: { icono: "📞", texto: "llamar" },
  seguimiento: { icono: "🔁", texto: "seguimiento" },
  otro: { icono: "📌", texto: "pendiente" },
};

function BloqueTareas({ tareas, cargando, onResolver, onAbrirChat, onRefrescar, puede }) {
  // Abierto por defecto cuando hay tareas: son compromisos que Biggy ya le
  // comunicó al conductor, así que esperan a alguien. Un bloque cerrado las
  // escondería justo cuando importan.
  const [abierto, setAbierto] = useState(true);
  if (!cargando && tareas.length === 0) return null;

  return (
    <div style={{ marginBottom: 8, border: "1px solid #c7d2fe", borderRadius: 9,
      background: "#eef2ff", overflow: "hidden" }}>
      <button onClick={() => setAbierto((v) => !v)}
        title="Cosas que Biggy prometió al conductor y hay que cumplir"
        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%",
          textAlign: "left", background: "transparent", border: "none",
          padding: "8px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 11, color: "#3730a3",
          transform: abierto ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#3730a3" }}>
          Tareas pendientes de Biggy
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#fff",
          background: "#4338ca", borderRadius: 9, padding: "1px 7px", minWidth: 18,
          textAlign: "center" }}>
          {cargando ? "…" : tareas.length}
        </span>
        <span role="button" tabIndex={0} title="Actualizar ahora"
          onClick={(e) => { e.stopPropagation(); onRefrescar?.(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onRefrescar?.(); } }}
          style={{ fontSize: 11, color: "#3730a3", cursor: "pointer", padding: "0 2px" }}>↻</span>
      </button>

      {abierto && (
        <div style={{ maxHeight: 300, overflowY: "auto", borderTop: "1px solid #c7d2fe" }}>
          <div style={{ fontSize: 10, color: "#3730a3", padding: "6px 10px", lineHeight: 1.35 }}>
            Biggy ya le dijo al conductor que la torre lo iba a gestionar.
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
                  {t.conductor || "sin conductor"}
                  {t.shipment_id ? ` · guía ${t.shipment_id}` : ""}
                </div>
                {puede && (
                  <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                    {t.conversacion_id && (
                      <button onClick={() => onAbrirChat(t)}
                        style={{ fontSize: 10.5, padding: "3px 9px" }}>
                        abrir chat
                      </button>
                    )}
                    <button className="btn-navy" onClick={() => onResolver(t, "hecha")}
                      style={{ fontSize: 10.5, padding: "3px 9px" }}>
                      ✓ hecha
                    </button>
                    <button onClick={() => onResolver(t, "descartada")}
                      title="Ya no aplica: el conductor resolvió, o el caso se cerró"
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


// ── Incidencias sin consulta ────────────────────────────────────────────────
// Un conductor levanta una incidencia en Logistic y sigue su ruta. Si nunca
// escribe a la torre, nadie sabe qué pasó realmente: si intentó entregar, si el
// cliente no estaba, o si la marcó sin bajarse del vehículo.
//
// El cruce es simple: por cada incidencia del día, ¿apareció su guía en algún
// mensaje de WhatsApp? Basta que la guía se haya mencionado en CUALQUIER
// dirección — si una analista le pasó los datos del paquete es porque el
// conductor preguntó por él (aunque fuera por foto o audio) y además ya quedó
// enterado. Medido el 11-ago: de 52 incidencias, 40 sin una sola mención.
//
// Efecto útil del criterio: el mensaje que manda este bloque incluye la guía,
// así que la incidencia sale de la lista sola. No hay estado que mantener.
const MOTIVOS_ES = {
  BUYER_ABSENT: "cliente ausente",
  BAD_ADDRESS: "dirección incorrecta",
  INACCESSIBLE_ADDRESS: "dirección inaccesible",
  BUSINESS_CLOSED: "negocio cerrado",
};
const motivoES = (m) => MOTIVOS_ES[m] || String(m || "una incidencia").toLowerCase().replace(/_/g, " ");

function BloqueSinConsulta({ filas, cargando, onPreguntar, onRefrescar }) {
  const [abierto, setAbierto] = useState(false);
  if (!cargando && filas.length === 0) return null;

  return (
    <div style={{ marginBottom: 8, border: "1px solid #fde68a", borderRadius: 9,
      background: "#fffbeb", overflow: "hidden" }}>
      <button onClick={() => setAbierto((v) => !v)}
        title="Incidencias del día por las que ningún conductor ha consultado"
        style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left",
          background: "transparent", border: "none", padding: "8px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 11, color: "#92400e", transform: abierto ? "rotate(90deg)" : "none",
          transition: "transform .15s" }}>▶</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#92400e" }}>Incidencias sin consulta</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#fff",
          background: "#b45309", borderRadius: 9, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>
          {cargando ? "…" : filas.length}
        </span>
        {/* Refrescar a mano: tras responder una consulta, esperar el ciclo hace
            dudar de si la lista está viva. Un span y no un button: anidar
            botones es HTML inválido y React lo advierte. */}
        <span role="button" tabIndex={0} title="Actualizar ahora"
          onClick={(e) => { e.stopPropagation(); onRefrescar?.(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onRefrescar?.(); } }}
          style={{ fontSize: 11, color: "#92400e", cursor: "pointer", padding: "0 2px" }}>
          ↻
        </span>
      </button>

      {abierto && (
        <div style={{ maxHeight: 320, overflowY: "auto", borderTop: "1px solid #fde68a" }}>
          <div style={{ fontSize: 10, color: "#92400e", padding: "6px 10px", lineHeight: 1.35 }}>
            El conductor nunca mencionó estas guías. Pregúntale qué pasó.
          </div>
          {filas.map((f) => (
            <div key={f.case_id} style={{ padding: "7px 10px", borderTop: "1px solid #fef3c7",
              background: "#fff" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, fontWeight: 600 }}>{f.hora}</span>
                <span style={{ fontSize: 11.5 }}>{motivoES(f.motivo)}</span>
                {f.abierta && (
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: "#b91c1c",
                    background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "0 5px" }}>
                    abierta
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginTop: 1 }}>
                {f.conductor || "sin conductor"} · {f.sc || "?"} · {f.ruta || "sin ruta"}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--texto-tenue)",
                fontVariantNumeric: "tabular-nums" }}>
                {f.shipment_id}
              </div>
              {/* El nombre del Directorio solo se muestra cuando NO coincide con
                  el de MELI: hay números con otra persona registrada, y la
                  analista tiene que saberlo antes de escribir. */}
              {f.nombre_directorio && f.conductor
                && f.nombre_directorio.toLowerCase().replace(/\s+/g, " ").trim()
                   !== f.conductor.toLowerCase().replace(/\s+/g, " ").trim() && (
                <div style={{ fontSize: 10, color: "#b45309", marginTop: 1 }}>
                  ⚠ el Directorio tiene ese número a nombre de {f.nombre_directorio}
                </div>
              )}
              {f.telefono_meli ? (
                <button onClick={() => onPreguntar(f)}
                  style={{ fontSize: 11, padding: "4px 10px", marginTop: 5 }}>
                  💬 Preguntar
                </button>
              ) : (
                <div style={{ fontSize: 10, color: "var(--texto-tenue)", fontStyle: "italic", marginTop: 4 }}>
                  Sin teléfono en la incidencia — buscar en el Directorio
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Buscador en los chats ───────────────────────────────────────────────────
// Como el buscador de WhatsApp: se escribe una guía (o una placa, un nombre,
// una frase) y aparecen todos los mensajes donde salió, de cualquier
// conversación, abierta o cerrada.
//
// El caso real (Monserrath, 16-ago): se cierra un ticket, más tarde llega la
// respuesta del cliente, y hay que revisar conversación por conversación para
// encontrar dónde quedó. Y en el cambio de turno: "¿ya se obtuvo respuesta de
// esta guía?" obligaba a buscar a mano lo que respondió Alan o Jorge.
//
// Al tocar un resultado se abre esa conversación. Sin copiar teléfonos ni
// adivinar en qué chat estaba.
function BuscadorChats({ onAbrir }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState("");

  async function buscar() {
    const t = q.trim();
    if (t.length < 3) { setErr("Escribe al menos 3 caracteres."); return; }
    setBuscando(true); setErr(""); setRes(null);
    const { data, error } = await sb.rpc("fn_buscar_en_chats", { p_texto: t, p_limite: 40 });
    setBuscando(false);
    if (error) { setErr("No se pudo buscar: " + error.message); return; }
    setRes(data || []);
  }

  return (
    <div style={{ borderBottom: "1px solid var(--borde)", paddingBottom: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🔎 Buscar en los chats</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          placeholder="Guía, placa, nombre o texto"
          style={{ flex: 1, fontSize: 12.5, padding: "6px 10px",
            border: "1px solid var(--borde)", borderRadius: 7 }} />
        <button onClick={buscar} disabled={buscando || q.trim().length < 3}
          style={{ fontSize: 12, padding: "6px 12px" }}>{buscando ? "…" : "Buscar"}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: "#791F1F", marginBottom: 8 }}>{err}</div>}

      {res && res.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", fontStyle: "italic" }}>
          Sin coincidencias en ningún chat.
        </div>
      )}

      {res && res.length > 0 && (
        <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--borde)",
          borderRadius: 8 }}>
          <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", padding: "5px 9px" }}>
            {res.length} coincidencia{res.length === 1 ? "" : "s"} · toca para abrir el chat
          </div>
          {res.map((r) => (
            <div key={r.mensaje_id} onClick={() => onAbrir(r)}
              style={{ padding: "7px 9px", borderTop: "1px solid #f1f5f9", cursor: "pointer",
                background: "#fff" }}>
              <div style={{ display: "flex", gap: 5, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, fontWeight: 600 }}>{r.conductor}</span>
                <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>{r.cuando_mx}</span>
                {r.codigo && (
                  <span style={{ fontSize: 9.5, padding: "0 5px", borderRadius: 8,
                    background: r.ticket_abierto ? "#fef3c7" : "#f1f5f9",
                    color: r.ticket_abierto ? "#92400e" : "var(--texto-suave)" }}>
                    {r.codigo}{r.ticket_abierto ? " abierto" : ""}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginTop: 1 }}>
                {r.direccion === "entrante" ? "conductor" : r.quien}
              </div>
              <div style={{ fontSize: 11, color: "var(--texto)", marginTop: 2,
                whiteSpace: "pre-wrap", lineHeight: 1.35 }}>
                {r.fragmento}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Buscador de ruta ────────────────────────────────────────────────────────
// Pedido por Monserrath el 13-ago. Su frase exacta: "aún hay Driver que no
// notifican y vamos a Logistic para visualizar cuáles son [los fallidos]".
// Pidió cuatro cosas: fallidos con ID y motivo, sacas, PLACES/comercios, y
// multiparadas ("como 18 paquetes a entregar en un mismo punto").
//
// Los fallidos van PRIMERO y abiertos: es lo que resuelve el viaje a Logistic.
// Fuera de zona no lo pidió, pero apareció en los datos (5 paradas en una sola
// ruta) y hoy nadie lo ve.
const MOTIVO_FALLIDO = {
  buyer_absent: "cliente ausente",
  bad_address: "dirección incorrecta",
  business_closed: "negocio cerrado",
  inaccessible_address: "dirección inaccesible",
  missing_package: "paquete faltante",
  broken_package: "paquete dañado",
  refused_delivery: "rechazó la entrega",
  missrouted: "fuera de zona",
  out_of_delivery_zone: "fuera de zona",
};
const motivoFallido = (m) =>
  MOTIVO_FALLIDO[m] || String(m || "sin motivo").replace(/_/g, " ");

function Bloque({ titulo, cuenta, color, abiertoPorDefecto, children }) {
  const [abierto, setAbierto] = useState(!!abiertoPorDefecto);
  if (!cuenta) return null;
  return (
    <div style={{ marginTop: 8, border: `1px solid ${color.borde}`, borderRadius: 8,
      background: color.fondo, overflow: "hidden" }}>
      <button onClick={() => setAbierto((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
          background: "transparent", border: "none", padding: "6px 9px", cursor: "pointer" }}>
        <span style={{ fontSize: 9.5, color: color.texto,
          transform: abierto ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: color.texto }}>{titulo}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#fff",
          background: color.texto, borderRadius: 9, padding: "0 6px" }}>{cuenta}</span>
      </button>
      {abierto && (
        <div style={{ borderTop: `1px solid ${color.borde}`, background: "#fff" }}>{children}</div>
      )}
    </div>
  );
}

const C_ROJO  = { fondo: "#fef2f2", borde: "#fca5a5", texto: "#b91c1c" };
const C_AMBAR = { fondo: "#fffbeb", borde: "#fde68a", texto: "#92400e" };
const C_AZUL  = { fondo: "#eff6ff", borde: "#bfdbfe", texto: "#1d4ed8" };
const C_GRIS  = { fondo: "#f8fafc", borde: "var(--borde)", texto: "var(--texto-suave)" };

function FilaParada({ p, extra }) {
  return (
    <div style={{ padding: "6px 9px", borderTop: "1px solid #f1f5f9", fontSize: 11 }}>
      <div style={{ display: "flex", gap: 5, alignItems: "baseline", flexWrap: "wrap" }}>
        <b>parada {p.parada ?? "?"}</b>
        <span>{p.direccion || "sin dirección"}</span>
        {p.estado === "complete" && (
          <span style={{ fontSize: 9.5, color: "#15803d" }}>· ya pasó</span>
        )}
      </div>
      {p.lugar && <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>{p.lugar}</div>}
      {p.horario && (
        <div style={{ fontSize: 10, color: "var(--texto-tenue)" }}>atienden {p.horario}</div>
      )}
      {p.paquetes > 1 && (
        <div style={{ fontSize: 10, color: "#92400e" }}>{p.paquetes} paquetes en este punto</div>
      )}
      {extra}
    </div>
  );
}

function BuscadorRuta({ onVerPaquete }) {
  const [id, setId] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState("");
  const [r, setR] = useState(null);

  async function buscar() {
    const limpio = id.replace(/\D/g, "");
    if (limpio.length < 6) { setErr("El ID de ruta tiene al menos 6 dígitos."); return; }
    setBuscando(true); setErr(""); setR(null);
    try {
      setR(await consultarRuta(limpio));
    } catch (e) {
      setErr(e.message || "No se pudo consultar la ruta.");
    } finally { setBuscando(false); }
  }

  const t = r?.totales || {};
  return (
    <div style={{ borderBottom: "1px solid var(--borde)", paddingBottom: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🚐 Buscar ruta</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input value={id} onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          placeholder="ID de ruta (ej. 151424352)"
          style={{ flex: 1, fontSize: 12.5, padding: "6px 10px",
            border: "1px solid var(--borde)", borderRadius: 7 }} />
        <button onClick={buscar} disabled={buscando || !id.trim()}
          style={{ fontSize: 12, padding: "6px 12px" }}>{buscando ? "…" : "Buscar"}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: "#791F1F", marginBottom: 8 }}>{err}</div>}

      {r && (
        <div>
          <div style={{ background: "#fafbfc", border: "1px solid var(--borde)", borderRadius: 8,
            padding: "9px 11px", fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <b>{r.ruta?.codigo || r.ruta?.id}</b>
              <span className="pill" style={{
                background: r.ruta?.estado === "active" ? "#fef3c7" : "#dcfce7",
                color: r.ruta?.estado === "active" ? "#92400e" : "#166534" }}>
                {r.ruta?.estado === "active" ? "en curso" : r.ruta?.estado}
              </span>
            </div>
            <div>{r.ruta?.conductor || "sin conductor"}</div>
            <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
              {r.ruta?.sc} · {r.ruta?.patente} · {r.ruta?.tipo_vehiculo}
              {r.ruta?.con_auxiliar ? " · con auxiliar" : ""}
            </div>
            {/* Avance en PAQUETES y no en paradas: es la unidad que usa MELI en
                sus counters y la que se compara con el nivel de servicio. */}
            <div style={{ marginTop: 4, fontSize: 11.5 }}>
              <b>{t.entregados ?? "?"}</b> de <b>{t.paquetes ?? "?"}</b> entregados
              {t.fallidos > 0 && (
                <span style={{ color: "#b91c1c", fontWeight: 600 }}> · {t.fallidos} fallidos</span>
              )}
              {t.por_entregar > 0 && (
                <span style={{ color: "var(--texto-suave)" }}> · {t.por_entregar} por entregar</span>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>
              {t.paradas} paradas · {t.pendientes} pendientes
            </div>
          </div>

          <Bloque titulo="Fallidos" cuenta={(r.fallidos || []).length} color={C_ROJO} abiertoPorDefecto>
            {(r.fallidos || []).map((f) => (
              <div key={f.guia} style={{ padding: "6px 9px", borderTop: "1px solid #fee2e2", fontSize: 11 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b style={{ fontVariantNumeric: "tabular-nums" }}>{f.guia}</b>
                  <span style={{ color: "#b91c1c", fontWeight: 600 }}>{motivoFallido(f.motivo)}</span>
                  <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>· parada {f.parada}</span>
                </div>
                <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>
                  {f.comprador || "sin nombre"} · {f.direccion}
                  {f.colonia ? `, ${f.colonia}` : ""}
                </div>
                {f.cuando && (
                  <div style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
                    {new Date(f.cuando).toLocaleTimeString("es-MX",
                      { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })} CDMX
                  </div>
                )}
                {onVerPaquete && (
                  <button onClick={() => onVerPaquete(f.guia)}
                    style={{ fontSize: 10.5, padding: "3px 8px", marginTop: 4 }}>
                    🔍 ver el paquete
                  </button>
                )}
              </div>
            ))}
          </Bloque>

          <Bloque titulo="Sacas" cuenta={(r.sacas || []).length} color={C_AMBAR} abiertoPorDefecto>
            {(r.sacas || []).map((p) => <FilaParada key={`s${p.parada}`} p={p} />)}
          </Bloque>

          <Bloque titulo="Multiparadas" cuenta={(r.multiparadas || []).length} color={C_AZUL}>
            {(r.multiparadas || []).map((p) => <FilaParada key={`m${p.parada}`} p={p} />)}
          </Bloque>

          <Bloque titulo="Fuera de zona y con problema" cuenta={(r.problemas || []).length} color={C_AMBAR}>
            {(r.problemas || []).map((p) => (
              <FilaParada key={`p${p.parada}`} p={p} extra={
                <div style={{ fontSize: 10, color: "#92400e" }}>
                  {[p.fuera_de_zona && "fuera de zona",
                    p.con_fallido && "con fallido",
                    p.con_reclamo && "con reclamo"].filter(Boolean).join(" · ")}
                </div>
              } />
            ))}
          </Bloque>

          <Bloque titulo="Próximos comercios" cuenta={(r.comerciales_proximas || []).length} color={C_GRIS}>
            {(r.comerciales_proximas || []).map((p) => <FilaParada key={`c${p.parada}`} p={p} />)}
          </Bloque>

          {r.siguiente && (
            <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--texto-suave)" }}>
              Primera pendiente en el sistema: <b>parada {r.siguiente.parada}</b> · {r.siguiente.direccion}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── Buscador puntual de paquetes (endpoint shipments de MELI) ───────────────
const ESTADO_PKG = {
  delivered: "Entregado", on_route: "En ruta", not_delivered: "No entregado",
  to_be_dispatched: "Por despachar", at_the_door: "En la puerta",
};
// Los teléfonos se comparan SIEMPRE por los últimos 10 dígitos: Meta los manda
// con código de país, MELI repite el mismo número con y sin él, y las tablas los
// guardan en formatos distintos.
const t10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

// Contactos de una incidencia en una sola forma.
// fn_incidencias_de_guia ya devuelve comprador_telefonos como arreglo (y en los
// casos viejos lo sintetiza desde el escalar), pero se tolera el nulo por si
// quedara corriendo una versión anterior de la función.
function telefonosDe(i) {
  const arr = Array.isArray(i.comprador_telefonos) ? i.comprador_telefonos : [];
  const lista = arr
    .map((c) => ({ numero: String(c?.numero || "").trim(), etiqueta: c?.etiqueta || null }))
    .filter((c) => c.numero);
  if (!lista.length && i.comprador_telefono) {
    lista.push({ numero: String(i.comprador_telefono), etiqueta: null });
  }
  // MELI trae el mismo número dos veces, con y sin código de país ("Registro"
  // repite el del "Segundo factor"). Se deduplica por los últimos 10 dígitos y
  // se conserva la primera etiqueta, que es la más específica.
  const vistos = new Set();
  return lista.filter((c) => {
    const k = t10(c.numero);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

function BuscadorPaquete({ onPasarAlChofer, idInicial }) {
  const [id, setId] = useState(idInicial || "");
  const [pkg, setPkg] = useState(null);
  const [incidencias, setIncidencias] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState("");

  // Deja que el buscador de RUTA mande una guía acá: la analista ve un fallido y
  // pasa directo a los datos del comprador sin copiar el número a mano.
  // El padre remonta el componente con key={guia}, así que este efecto de montaje
  // corre una sola vez por guía y no necesita comparar valores anteriores.
  const montado = useRef(false);
  useEffect(() => {
    if (montado.current || !idInicial) return;
    montado.current = true;
    buscarGuia(idInicial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function buscar() { return buscarGuia(id); }

  async function buscarGuia(entrada) {
    const limpio = String(entrada || "").replace(/\D/g, "");
    if (!limpio || buscando) return;
    setId(limpio);
    setBuscando(true); setErr(""); setPkg(null); setIncidencias([]);
    const aviso = setTimeout(() => setErr("Despertando el buscador… un momento."), 2500);

    // Las dos consultas van en paralelo: la de incidencias es local y responde
    // al instante, así que no tiene sentido esperar a MELI para lanzarla.
    // Y si MELI falla, las incidencias igual se muestran: para un paquete que ya
    // tuvo problemas, ese historial suele ser lo más útil.
    const [p, inc] = await Promise.allSettled([
      consultarPaquete(limpio),
      sb.rpc("fn_incidencias_de_guia", { p_guia: limpio }),
    ]);
    clearTimeout(aviso);

    if (p.status === "fulfilled") { setPkg(p.value); setErr(""); }
    else setErr(p.reason?.message || "No se pudo consultar MELI. Reintenta en unos segundos.");

    if (inc.status === "fulfilled" && !inc.value.error) setIncidencias(inc.value.data || []);
    setBuscando(false);
  }

  // La referencia guardada en una incidencia previa la escribió un analista y
  // suele ser mejor que el comentario de MELI: se agrega si es distinta.
  const refIncidencia = incidencias.find((i) => i.referencia)?.referencia;
  const fallosPrevios = incidencias.length;

  // Números que guardaron las incidencias y que MELI NO devuelve. Son los que
  // le faltan al conductor: MELI entrega un solo contacto ("Quien recibe"),
  // mientras la incidencia guarda también el segundo factor de verificación.
  const telsExtra = (() => {
    const vistos = new Set([t10(pkg?.comprador?.telefono)].filter(Boolean));
    const out = [];
    for (const i of incidencias) {
      for (const c of telefonosDe(i)) {
        const k = t10(c.numero);
        if (!k || vistos.has(k)) continue;
        vistos.add(k);
        out.push(c);
      }
    }
    return out;
  })();

  const textoChofer = pkg ? [
    `📦 Paquete ${pkg.id}`,
    pkg.comprador?.nombre ? `Cliente: ${pkg.comprador.nombre}` : null,
    pkg.comprador?.telefono ? `Tel: ${pkg.comprador.telefono}` : null,
    pkg.comprador?.direccion ? `Dirección: ${pkg.comprador.direccion}` : null,
    pkg.comprador?.comentario ? `Referencia: ${pkg.comprador.comentario}` : null,
    // Un solo número y sin respuesta es un intento perdido: van todos.
    ...telsExtra.map((c) =>
      `Tel alternativo${c.etiqueta ? ` (${c.etiqueta})` : ""}: ${c.numero}`),
    refIncidencia && refIncidencia !== pkg.comprador?.comentario
      ? `Dato adicional: ${refIncidencia}` : null,
    fallosPrevios > 1
      ? `\n⚠️ Este paquete ya tuvo ${fallosPrevios} incidencias. Conviene llamar antes de ir.`
      : null,
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

      {/* Incidencias previas de esta guía.
          Se muestran aunque MELI haya fallado: para un paquete con problemas,
          este historial suele ser más útil que el contacto. */}
      {incidencias.length > 0 && (
        <div style={{
          marginTop: 8, borderRadius: 8, padding: "10px 12px", fontSize: 12,
          background: incidencias.length > 1 ? "#fef2f2" : "#fffbeb",
          border: `1px solid ${incidencias.length > 1 ? "#fca5a5" : "#fde68a"}`,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6,
            color: incidencias.length > 1 ? "#b91c1c" : "#92400e" }}>
            {incidencias.length === 1
              ? "1 incidencia previa"
              : `${incidencias.length} incidencias — ya falló varias veces`}
          </div>

          {incidencias.length > 1 && (
            <div style={{ fontSize: 11.5, color: "#b91c1c", marginBottom: 7, lineHeight: 1.45 }}>
              Dile al conductor que llame al comprador <b>antes de ir</b>: repetir el viaje sin
              coordinar es perder otro intento.
            </div>
          )}

          {incidencias.map((i) => {
            const tels = telefonosDe(i);
            // "Distinto al de MELI" ya no aplica número por número. Con dos
            // contactos legítimos guardados, la pregunta correcta es si el de
            // MELI está ENTRE ellos: si está, no hay discrepancia (antes se
            // marcaba ámbar sin motivo). Si no está, ninguno de los guardados es
            // el vigente y hay que probarlos todos.
            const telMeli = t10(pkg?.comprador?.telefono);
            const meliCalza = !telMeli || tels.some((c) => t10(c.numero) === telMeli);
            return (
            <div key={i.case_id} style={{
              padding: "5px 0", borderTop: "1px dashed rgba(0,0,0,.12)", lineHeight: 1.5,
            }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{i.cuando}</b>
                <span>{i.motivo}</span>
                {i.abierta && (
                  <span className="pill" style={{ background: "#fff", border: "1px solid #fca5a5",
                    color: "#b91c1c", fontSize: 10 }}>abierta</span>
                )}
                {i.cierre && (
                  <span style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{i.cierre}</span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>
                #{i.case_id}
                {i.sc ? ` · ${i.sc}` : ""}
                {i.ruta ? ` · ruta ${i.ruta}` : ""}
                {i.conductor ? ` · ${i.conductor}` : ""}
              </div>

              {/* Datos del comprador guardados en la incidencia.
                  MELI da UN contacto por paquete ("Quien recibe"); la incidencia
                  guarda la tabla completa, con el segundo factor de verificación.
                  Se muestran TODOS con su etiqueta: un solo número que no
                  contesta es un intento de entrega perdido. */}
              {(i.comprador_nombre || tels.length > 0 || i.comprador_mail) && (
                <div style={{ marginTop: 4, padding: "5px 8px", background: "#fff",
                  border: "1px solid var(--borde)", borderRadius: 6, fontSize: 11.5 }}>
                  {i.comprador_nombre && (
                    <div><span style={{ color: "var(--texto-suave)" }}>Cliente:</span>{" "}
                      {i.comprador_nombre}</div>
                  )}
                  {tels.length > 0 && (
                    <div>
                      <span style={{ color: "var(--texto-suave)" }}>
                        {tels.length > 1 ? "Teléfonos:" : "Teléfono:"}
                      </span>
                      {tels.map((c) => (
                        <div key={c.numero} style={{ paddingLeft: 2 }}>
                          <b style={{ fontVariantNumeric: "tabular-nums" }}>{c.numero}</b>
                          {c.etiqueta && (
                            <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
                              {" "}· {c.etiqueta}
                            </span>
                          )}
                          {telMeli && t10(c.numero) === telMeli && (
                            <span style={{ fontSize: 10, color: "#15803d" }}> · vigente en MELI</span>
                          )}
                        </div>
                      ))}
                      {!meliCalza && (
                        <div style={{ fontSize: 10, color: "#b45309" }}>
                          MELI devuelve otro número: prueba los {tels.length + 1}.
                        </div>
                      )}
                    </div>
                  )}
                  {i.comprador_mail && (
                    <div><span style={{ color: "var(--texto-suave)" }}>Correo:</span>{" "}
                      {i.comprador_mail}</div>
                  )}
                  {i.referencia && (
                    <div style={{ fontStyle: "italic", color: "var(--texto-suave)" }}>
                      Ref: {i.referencia}
                    </div>
                  )}
                  {i.quien_recibio && (
                    <div style={{ color: "#15803d" }}>Recibió: {i.quien_recibio}</div>
                  )}
                  {onPasarAlChofer && (
                    <button onClick={() => onPasarAlChofer([
                      `📦 Paquete ${id.replace(/\D/g, "")}`,
                      i.comprador_nombre ? `Cliente: ${i.comprador_nombre}` : null,
                      // Todos los números, con etiqueta cuando hay más de uno.
                      // El correo NO va: el conductor no le escribe mails al
                      // comprador, y es un dato personal de más en WhatsApp.
                      ...(tels.length === 1
                        ? [`Tel: ${tels[0].numero}`]
                        : tels.map((c) =>
                            `Tel${c.etiqueta ? ` (${c.etiqueta})` : ""}: ${c.numero}`)),
                      i.referencia ? `Referencia: ${i.referencia}` : null,
                    ].filter(Boolean).join("\n"))}
                      style={{ marginTop: 5, fontSize: 11, padding: "4px 10px" }}>
                      📤 Pasar estos datos
                    </button>
                  )}
                </div>
              )}

              {/* Sin datos guardados: se dice por qué, en vez de dejar el hueco.
                  Los casos anteriores al 10 de agosto no se enriquecieron. */}
              {!i.comprador_nombre && tels.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--texto-tenue)", fontStyle: "italic" }}>
                  Sin datos del comprador guardados en esta incidencia
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {pkg && incidencias.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 6 }}>
          Sin incidencias previas de esta guía.
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
  const [nuevoMsj, setNuevoMsj] = useState(false);

  // Guía que el buscador de ruta manda al buscador de paquete. Va con key para
  // que el componente se remonte y busque solo.
  const [guiaDesdeRuta, setGuiaDesdeRuta] = useState(null);

  // Precarga para NuevoMensaje cuando se abre desde una incidencia sin consulta.
  const [precarga, setPrecarga] = useState(null);


  // Abre el panel de envío ya listo: teléfono de la incidencia, ruta, y el
  // motivo redactado con la guía dentro — esa guía es la que hace que la
  // incidencia salga de la lista cuando el mensaje sale.
  function preguntarPorIncidencia(f) {
    setPrecarga({
      nombre: f.conductor || "conductor",
      telefono: f.telefono_meli,
      sc: f.sc,
      ruta: f.ruta || f.sc || "",
      origen: "Incidencia " + f.shipment_id,
      alternos: Array.isArray(f.telefonos_alternos) ? f.telefonos_alternos : [],
      motivo: `Registraste una incidencia por ${motivoES(f.motivo)} en el paquete `
            + `${f.shipment_id} y no nos has contactado. ¿Nos cuentas qué pasó?`,
    });
    setNuevoMsj(true);
  }
  const [convs, setConvs] = useState([]);
  const [fechaSel, setFechaSel] = useState(diaMX());
  // Incidencias del día sin una sola mención de su guía en WhatsApp.
  // Turno de Biggy. Se refresca cada 30 s porque la cuenta regresiva avanza
  // sola y porque otra analista puede activarlo o apagarlo.
  const [turno, setTurno] = useState(null);
  const [turnoOcupado, setTurnoOcupado] = useState(false);
  const cargarTurno = useCallback(async () => {
    const { data, error } = await sb.rpc("fn_biggy_estado_turno");
    if (!error) setTurno(data || null);
  }, []);
  useEffect(() => {
    cargarTurno();
    const t = setInterval(cargarTurno, 30000);
    return () => clearInterval(t);
  }, [cargarTurno]);

  async function activarTurno(minutos, nivel) {
    setTurnoOcupado(true);
    const { error } = await sb.rpc("fn_biggy_turno", { p_minutos: minutos, p_nivel: nivel });
    setTurnoOcupado(false);
    if (error) { alert("No se pudo activar: " + error.message); return; }
    await cargarTurno();
  }

  async function apagarTurno() {
    setTurnoOcupado(true);
    const { error } = await sb.rpc("fn_biggy_turno", { p_minutos: null, p_nivel: "auto" });
    setTurnoOcupado(false);
    if (error) { alert("No se pudo apagar: " + error.message); return; }
    await cargarTurno();
  }

  // Tareas que Biggy prometió y esperan a un humano.
  const [tareas, setTareas] = useState([]);
  const [cargandoTareas, setCargandoTareas] = useState(true);
  const cargarTareas = useCallback(async () => {
    setCargandoTareas(true);
    const { data, error } = await sb.from("biggy_tareas")
      .select("*").eq("estado", "pendiente").order("creada_en", { ascending: false }).limit(50);
    setTareas(error ? [] : (data || []));
    setCargandoTareas(false);
  }, []);
  useEffect(() => {
    cargarTareas();
    const t = setInterval(cargarTareas, 60000);
    return () => clearInterval(t);
  }, [cargarTareas]);

  async function resolverTarea(t, estado) {
    // Se pide nota solo al descartar: si ya no aplica, conviene saber por qué —
    // es la señal de que Biggy está prometiendo cosas que no correspondían.
    let nota = null;
    if (estado === "descartada") {
      nota = window.prompt("¿Por qué ya no aplica?", "");
      if (nota === null) return;
    }
    const { error } = await sb.rpc("fn_tarea_resolver",
      { p_id: t.id, p_estado: estado, p_nota: nota || null });
    if (error) { alert("No se pudo actualizar: " + error.message); return; }
    await cargarTareas();
  }

  const [sinConsulta, setSinConsulta] = useState([]);
  const [cargandoSC, setCargandoSC] = useState(true);
  const cargarSinConsulta = useCallback(async () => {
    setCargandoSC(true);
    const { data, error } = await sb.rpc("fn_incidencias_sin_consulta", { p_fecha: fechaSel });
    // Si falla, el bloque simplemente no aparece: es información adicional y no
    // puede impedir que la analista atienda sus conversaciones.
    setSinConsulta(error ? [] : (data || []));
    setCargandoSC(false);
  }, [fechaSel]);

  // Cada 60 s. Se probó con 3 min y era demasiado: la analista respondía la
  // consulta y seguía viendo la fila en la lista, lo que la hacía dudar de si el
  // sistema funcionaba. Lo que manda el intervalo no es cuándo LLEGAN las
  // incidencias (cada 5 min con el sincronizador) sino cuándo DESAPARECEN, que
  // ocurre en el momento en que alguien menciona la guía. La consulta es
  // liviana, así que el costo de bajarlo es despreciable.
  useEffect(() => {
    cargarSinConsulta();
    const t = setInterval(cargarSinConsulta, 60000);
    return () => clearInterval(t);
  }, [cargarSinConsulta]);

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

  // Los borradores de Biggy son simulaciones de lo que RESPONDERÍA si estuviera
  // activo: nadie tiene que hacer nada con ellos. En el hilo de una analista son
  // ruido —tapan lo que dijo el conductor y hacen dudar de si algo se envió— así
  // que se ocultan. Quedan disponibles solo para admin, porque son la única
  // ventana a lo que Biggy haría y la materia prima del futuro botón "Enviar
  // borrador" con el que se va a medir si acierta.
  const esAdmin = analista?.rol === "admin";
  const [verBorradores, setVerBorradores] = useState(false);

  // Estado de ticket por conversación, para la lista. Una sola consulta para
  // todas las filas —no una por fila— y refresco cada 30 s porque el reloj
  // corre solo aunque no pase nada en la base.
  const [estadoTk, setEstadoTk] = useState({});
  const cargarEstadoTickets = useCallback(async () => {
    const { data, error } = await sb.rpc("fn_consultas_estado_tickets", { p_fecha: fechaSel });
    // Si falla, la lista sigue funcionando sin los avisos: es información
    // adicional, no puede tumbar la pantalla.
    if (error) return;
    const mapa = {};
    for (const r of (data || [])) mapa[r.conversacion_id] = r;
    setEstadoTk(mapa);
  }, [fechaSel]);

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

  // Se recarga al cambiar el día, cuando llega algo nuevo a la lista, y cada
  // 30 s para que el reloj avance sin depender de eventos.
  useEffect(() => {
    cargarEstadoTickets();
    const t = setInterval(cargarEstadoTickets, 30000);
    return () => clearInterval(t);
  }, [cargarEstadoTickets, convs]);
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

  // Abre la conversación de un resultado de búsqueda. Puede no estar en la
  // lista del día seleccionado —el caso típico es un ticket cerrado de ayer—,
  // así que se trae por id en vez de buscarla entre las cargadas.
  async function abrirDesdeBusqueda(r) {
    const enLista = (convs || []).find((c) => c.id === r.conversacion_id);
    if (enLista) { abrirConv(enLista); return; }
    const { data, error } = await sb.from("crm_inc_conversaciones")
      .select("*").eq("id", r.conversacion_id).maybeSingle();
    if (error || !data) { alert("No se pudo abrir esa conversación."); return; }
    // Se cambia el día al del mensaje encontrado: si no, la conversación se abre
    // pero la lista de la izquierda queda mostrando otro día y desorienta.
    if (r.cuando) setFechaSel(diaMX(r.cuando));
    abrirConv(data);
  }

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

  // ── Bajar la línea de cierre ──────────────────────────────────────────────
  // Incluye en el ticket ya cerrado los mensajes huérfanos hasta el elegido.
  // Queda registro en crm_inc_historial de quién lo hizo y qué movió, tantas
  // veces como se haga.
  const [moviendoCierre, setMoviendoCierre] = useState(null);

  async function moverCierre(caso, hastaMensajeId) {
    if (!caso?.id || moviendoCierre) return;
    setMoviendoCierre(hastaMensajeId);
    const { data, error } = await sb.rpc("fn_mover_cierre", {
      p_caso_id: caso.id, p_hasta_mensaje_id: hastaMensajeId,
    });
    setMoviendoCierre(null);
    if (error) { alert("No se pudo mover el cierre: " + error.message); return; }
    if (data?.incluidos === 0) { alert("No había mensajes sin ticket para incluir."); return; }
    await abrirConv(sel);
  }

  async function deshacerCierre(caso) {
    if (!caso?.id) return;
    const { data, error } = await sb.rpc("fn_mover_cierre", {
      p_caso_id: caso.id, p_hasta_mensaje_id: null,
    });
    if (error) { alert("No se pudo deshacer: " + error.message); return; }
    if (data?.liberados === 0) { alert("No hay mensajes movidos que devolver."); return; }
    await abrirConv(sel);
  }

  async function reabrir(caso) {
    if (!caso?.id) return;
    const motivo = window.prompt(
      `¿Por qué se reabre ${caso.codigo || "#" + caso.case_id}?\n` +
      "El cronómetro vuelve a correr desde ahora.", "");
    if (motivo === null) return;   // canceló
    setAccion(true);
    const { data, error } = await sb.rpc("fn_reabrir_ticket", {
      p_caso_id: caso.id, p_motivo: motivo || null,
    });
    setAccion(false);
    if (error) { alert("No se pudo reabrir: " + error.message); return; }
    if (data === "solo_consultas") { alert("Las incidencias de MELI se reabren en MELI."); return; }
    if (data === "ya_abierto") { alert("Ese ticket ya está abierto."); return; }
    await cargarConvs();
    if (sel) await cargarHilo(sel);
  }

  function renderHilo() {
    const out = [];

    // Se filtra ANTES de recorrer para que el cálculo de posición de los
    // separadores use los mensajes realmente visibles: si se filtrara al
    // dibujar, un cierre podría caer en el hueco de un borrador oculto.
    const visibles = (mensajes || []).filter((m) =>
      !(m.direccion === "nota_interna" && m.emisor === "ia") || (esAdmin && verBorradores));

    // Cierres pendientes de dibujar, ordenados por su HORA REAL de cierre.
    // Antes el separador se insertaba cuando cambiaba el case_id, y eso lo
    // ubicaba mal: Biggy le cuelga sus borradores al ticket incluso ya cerrado,
    // así que un borrador posterior arrastraba la línea verde por debajo de
    // mensajes llegados mucho después. Caso real de ulises morales: el ticket
    // se cerró 11:35 y la línea aparecía tras las fotos de 13:13, como si se
    // hubiera cerrado casi dos horas más tarde.
    // Sin fecha de cierre → Infinity, así caen al final en vez de desaparecer.
    // Descartarlos habría sido peor que el problema original: un separador mal
    // ubicado confunde, uno ausente hace creer que el ticket sigue abierto.
    const cierres = Object.values(casos || {})
      .filter((c) => c && c.origen !== "meli" && !ABIERTOS.includes(c.estado_id))
      .map((c) => {
        const en = c.resuelto_en || c.cierre_local_en || null;
        // La línea se DIBUJA tras el último mensaje que pertenece al ticket, no
        // en la hora de cierre. Son dos cosas distintas a propósito:
        //   · resuelto_en no se mueve nunca — es cuándo terminó la gestión, y
        //     de ahí sale el tiempo de cierre de la analista.
        //   · la posición de la línea sí, porque al bajarla la analista incluyó
        //     mensajes posteriores y la línea tiene que quedar debajo de ellos.
        // Antes se usaba resuelto_en para las dos cosas, así que al mover la
        // línea el dato cambiaba y el dibujo no: se veía como si no hubiera
        // pasado nada.
        // El sello sigue mostrando la hora real: "✓ BT-… · Monserrath · 11:35".
        const ultimoDelTicket = (visibles || [])
          .filter((m) => m.case_id === c.case_id)
          .reduce((max, m) => {
            const t = new Date(m.creado_en).getTime();
            return t > max ? t : max;
          }, 0);
        const tCierre = en ? new Date(en).getTime() : Infinity;
        return {
          c, en,
          // Se toma el mayor de los dos: si nadie movió nada, el último mensaje
          // del ticket es anterior al cierre y la línea queda donde siempre.
          t: Math.max(tCierre === Infinity ? 0 : tCierre, ultimoDelTicket) || Infinity,
        };
      })
      .sort((a, b) => a.t - b.t);
    let ic = 0;

    function dibujarCierre(x) {
      const c = x.c;
      const por = c.cierre_local_por ? nombresAnalistas[c.cierre_local_por] : null;
      // Cuántos mensajes se incluyeron bajando la línea: son los que están
      // dentro del ticket pero DESPUÉS de su cierre.
      const movidos = visibles.filter(
        (m) => m.case_id === c.case_id && x.en
               && new Date(m.creado_en).getTime() > new Date(x.en).getTime()
               && m.direccion === "entrante").length;
      out.push(<LineaCierre key={`cierre-${c.case_id}`} codigo={c.codigo || "#" + c.case_id}
        anidadoEn={c.anidado_en_case_id || null}
        caso={c} analistaId={analista?.id} onReabrir={reabrir} cerradoPor={por}
        onDeshacer={puedeActuar(analista) ? deshacerCierre : null} movidos={movidos} />);
    }

    // El último ticket cerrado del hilo: es el que recibe los mensajes al bajar
    // la línea. Solo tiene sentido ofrecerlo sobre huérfanos posteriores a él.
    const ultimoCerrado = cierres.length ? cierres[cierres.length - 1] : null;

    for (let i = 0; i < visibles.length; i++) {
      const m = visibles[i];
      out.push(<Burbuja key={m.id} m={m} />);

      // Todo cierre ocurrido entre este mensaje y el siguiente va acá.
      // Se compara en milisegundos y no con objetos Date: new Date(null) da
      // 1970 y un cierre sin fecha se habría dibujado al principio del hilo.
      const tMsg = new Date(m.creado_en).getTime();
      const tSig = visibles[i + 1] ? new Date(visibles[i + 1].creado_en).getTime() : null;
      // Estricto (<) y no (<=): cuando la línea se bajó hasta el ÚLTIMO mensaje
      // del hilo, su posición coincide exactamente con la hora de ese mensaje.
      // Con <= se descartaba como "ya pasada" justo al llegar ahí y la línea
      // desaparecía del hilo — peor que estar mal puesta, porque el ticket se
      // veía como si siguiera abierto. Ahora cae en el bloque que dibuja los
      // cierres restantes al final, que es donde corresponde.
      while (ic < cierres.length && cierres[ic].t < tMsg) ic++;           // ya pasado
      while (ic < cierres.length && tSig !== null && cierres[ic].t < tSig) {
        dibujarCierre(cierres[ic]); ic++;
      }

      // Control para bajar el cierre: se ofrece bajo cada mensaje SIN TICKET que
      // sea posterior al último cierre del hilo.
      if (!m.case_id && ultimoCerrado && puedeActuar(analista)
          && new Date(m.creado_en).getTime() > (ultimoCerrado.t || 0)) {
        out.push(
          <CerrarAqui key={`cerraqui-${m.id}`}
            moviendo={moviendoCierre === m.id}
            onMover={() => moverCierre(ultimoCerrado.c, m.id)} />);
      }

      const cid = m.case_id;
      const sig = visibles[i + 1];
      const cambiaTicket = !sig || sig.case_id !== cid;
      if (cid && cambiaTicket && casos[cid]) {
        const c = casos[cid];
        // El cartel de "anidado" solo se muestra si hay un mensaje ENTRANTE con
        // ese case_id. Escribirle al conductor desde una incidencia deja el
        // saliente ligado a ese ticket —correcto, pertenece a su historial— pero
        // NO anida la conversación: eso lo decide el analista con el botón.
        // Antes bastaba el saliente y el cartel aparecía solo, contradiciendo a
        // dónde iban realmente los mensajes nuevos.
        const anidadoDeVerdad = visibles.some(
          (x) => x.case_id === cid && x.direccion === "entrante");
        if (c.origen === "meli" && anidadoDeVerdad) {
          // tramo anidado: la conversación se gestiona desde Incidencias
          out.push(<LineaCierre key={`anid-${cid}`} codigo={"Conversación"} anidadoEn={cid} />);
        }
        // El separador de cierre ya no se dibuja acá: lo hace el bloque de
        // arriba, ubicado por hora real. Solo queda el de anidado, que sí
        // depende del tramo de mensajes y no de un instante.
      }
    }
    // Cierres sin ningún mensaje posterior —lo normal cuando nadie escribió
    // después— van al final del hilo.
    while (ic < cierres.length) { dibujarCierre(cierres[ic]); ic++; }
    return out;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(270px, 0.75fr) 1.7fr minmax(270px, 0.8fr)", height: "100%" }}>
      {/* ── COLUMNA 1 · conversaciones del día ── */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--borde)",
          position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <BloqueTareas tareas={tareas} cargando={cargandoTareas}
            onResolver={resolverTarea} onRefrescar={cargarTareas}
            puede={puedeActuar(analista)}
            onAbrirChat={(t) => abrirDesdeBusqueda({
              conversacion_id: t.conversacion_id, cuando: t.creada_en })} />
          <TurnoBiggy estado={turno} onActivar={activarTurno} onApagar={apagarTurno}
            ocupado={turnoOcupado} puede={puedeActuar(analista)} />
          <BloqueSinConsulta filas={sinConsulta} cargando={cargandoSC}
            onPreguntar={preguntarPorIncidencia} onRefrescar={cargarSinConsulta} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Consultas en ruta</div>
            <button className="btn-naranja" onClick={() => setNuevoMsj(true)}
              title="Escribirle a un conductor que no ha iniciado conversación"
              style={{ fontSize: 11.5, padding: "5px 10px", whiteSpace: "nowrap" }}>
              ✏️ Nuevo
            </button>
          </div>
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
              <AvisoTicket e={estadoTk[c.id]} />
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
            {esAdmin && (
              <label title="Los borradores son lo que Biggy respondería si estuviera activo. No se envían."
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5,
                  color: "var(--texto-suave)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
                <input type="checkbox" checked={verBorradores}
                  onChange={(e) => setVerBorradores(e.target.checked)}
                  style={{ width: "auto", margin: 0 }} />
                🤖 borradores
              </label>
            )}
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
                <div style={{ padding: "11px 16px", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <BotonAdjunto telefono={sel?.telefono} caseId={ticketAbierto?.case_id}
                    conversacionId={sel?.id} disabled={accion || ticketDeOtro}
                    onEnviado={() => cargarHilo(sel)} />
                  <GrabadorAudio telefono={sel?.telefono} caseId={ticketAbierto?.case_id}
                    conversacionId={sel?.id} disabled={accion || ticketDeOtro}
                    onEnviado={() => cargarHilo(sel)} />
                  <SelectorEmoji disabled={accion || ticketDeOtro}
                    onElegir={(e) => setTexto((t) => t + e)} />
                  <BotonLlamar telefono={sel?.telefono}
                    nombre={contexto.nombre || nombresLista[sel?.telefono] || sel?.conductor_nombre}
                    disabled={ticketDeOtro} />
                  {/* textarea en vez de input: los mensajes al conductor llevan
                      dirección, referencia y varias líneas, y en un campo de una
                      sola línea no se alcanza a revisar lo escrito */}
                  <textarea value={texto} rows={2} onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
                    placeholder={ticketDeOtro
                      ? `Ticket de ${nombresAnalistas[ticketAbierto.analista_actual] || "otro analista"} — traspásatelo para escribir`
                      : "Escribe al conductor…  (Enter envía · Shift+Enter salta línea)"}
                    disabled={accion || ticketDeOtro}
                    style={{
                      flex: 1, minWidth: 200, fontFamily: "inherit", fontSize: 13,
                      padding: "9px 12px", border: "1px solid var(--borde)",
                      borderRadius: 9, resize: "vertical", lineHeight: 1.45,
                    }} />
                  <button className="btn-navy" onClick={enviar} disabled={accion || !texto.trim() || ticketDeOtro || (ticketAbierto && ticketAbierto.analista_actual && ticketAbierto.analista_actual !== analista?.id)}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>{accion ? "…" : "Enviar"}</button>
                  <button className="btn-naranja" onClick={cerrar} disabled={accion || ticketDeOtro}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>Cerrar ticket</button>
                </div>
              </>
            ) : haySinCaso ? (
              <div style={{ padding: "11px 16px" }}>
                {/* Un observador no ve el botón: la base igual lo rechazaría,
                     pero mostrarlo sería ofrecerle algo que no puede hacer. */}
                {puedeActuar(analista) ? (
                <button className="btn-navy" onClick={tomar} disabled={accion} style={{ width: "100%", padding: "10px" }}>
                  {accion ? "Creando ticket…" : "Tomar consulta y crear ticket"}
                </button>
                ) : (
                  <div style={{ padding: "12px", textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>
                    Solo lectura — puedes ver la conversación pero no tomarla.
                  </div>
                )}
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
      {nuevoMsj && (
        <NuevoMensaje
          analistaId={analista?.id}
          inicial={precarga}
          onCerrar={() => { setNuevoMsj(false); setPrecarga(null); }}
          onAbrirConversacion={async (convId) => {
            await cargarConvs();
            cargarSinConsulta();   // el mensaje lleva la guía: la fila desaparece
            if (convId) {
              const c = (convs || []).find((x) => x.id === convId);
              if (c) abrirConv(c); else setParams({ conv: convId }, { replace: true });
            }
          }}
        />
      )}

      <div style={{ borderLeft: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        {!sel ? (
          <div style={{ padding: 20, fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>—</div>
        ) : (
          <div style={{ padding: 14 }}>
            <BuscadorChats onAbrir={abrirDesdeBusqueda} />
            <BuscadorRuta onVerPaquete={(guia) => setGuiaDesdeRuta(guia)} />
            <BuscadorPaquete key={guiaDesdeRuta || "vacio"} idInicial={guiaDesdeRuta}
              onPasarAlChofer={(t) => setTexto((prev) => (prev ? prev + "\n" : "") + t)} />
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
