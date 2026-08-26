import { Fragment, useState, useEffect, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ── Posventa ───────────────────────────────────────────────────────────────
// Hoy solo PNR; las devoluciones entran después como una segunda vista del
// mismo módulo. Lee vw_pnr_tablero completa (155 filas hoy, unos pocos miles
// en el peor caso) y agrega en el cliente: una consulta por carga en vez de
// tres RPC de totales que después habría que mantener sincronizadas a mano
// con la misma regla de clasificación.

// El detalle de MELI es SSR: no hay JSON que pedir, hay que abrir la página.
// Por eso vive en un servicio aparte del VPS de México, detrás de Caddy, y se
// llama solo cuando el analista despliega una fila. El resultado queda en
// pnr_detalle_mx, así que la segunda vez que abren ese caso ya viene con la
// consulta principal y no hay llamada.
const API_PNR = import.meta.env.VITE_PNR_API_URL || "https://api-mx.bigticket.cl/pnr";
const SECRETO_PNR = import.meta.env.VITE_PNR_API_SECRET || "";
const FRESCURA_MS = 12 * 3600 * 1000;

// Webhook de n8n que dispara los dos WhatsApp y el correo. Va como variable de
// entorno y no en duro porque la URL cambia entre la instancia de pruebas y la
// de producción, y equivocarse ahí significa mandarle mensajes reales a un
// conductor durante una prueba.
const WEBHOOK_NOTIFICAR = import.meta.env.VITE_PNR_WEBHOOK || "";
const WEBHOOK_SECRETO = import.meta.env.VITE_PNR_WEBHOOK_SECRET || "";

function detalleFresco(c) {
  if (!c || !c.detalle_capturado_en) return false;
  return Date.now() - new Date(c.detalle_capturado_en).getTime() < FRESCURA_MS;
}

// Campos que el detalle puede aportar a una fila. Lista blanca a propósito:
// mezclar el objeto entero pisaba `periodo` con el null que trae el detalle
// de algunos casos, la fila se caía del filtro de quincena, la lista se
// reordenaba y en esa posición quedaba otro caso — con otro nombre. La fila
// abierta parecía cambiar de conductor sola.
//
// texto_crudo tampoco entra: son ~4 KB por caso que no se muestran en ningún
// lado y que por 204 filas solo ocupan memoria.
const CAMPOS_DETALLE = [
  "producto", "valor_compra", "reclamante", "designado_recibir", "mensaje_reclamo",
  "entregado_en", "recibio_quien", "recibio_nombre", "recibio_documento",
  "distancia_texto", "responsable", "tipo_operacion", "direccion_envio",
  "transportadora", "transportista", "conductor_id", "telefono",
  "estacion_destino", "id_seguimiento", "estado_texto",
  "telefono_reclamante", "telefonos_alternos", "direccion_entrega",
];

function soloDetalle(d) {
  const out = {};
  for (const k of CAMPOS_DETALLE) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

const VISTAS = [
  { clave: "pnr",          etiqueta: "PNR",          activa: true  },
  { clave: "devoluciones", etiqueta: "Devoluciones", activa: false },
];

// Paleta. Navy y naranja son los institucionales; los otros tres se derivan
// de ellos en vez de traer una familia nueva. El ladrillo es el naranja
// oscurecido y desaturado, así la pérdida se lee como "esto se apagó" y no
// como una alerta de sistema. El verde queda reservado para una sola cosa:
// el cumplimiento de un hito. Si el verde apareciera también en montos o
// bordes, el tilde dejaría de saltar a la vista, que es lo único que tiene
// que hacer.
const C = {
  navy:         "#1a3a6b",
  navyTenue:    "#eef2f8",
  naranja:      "#F47B20",
  naranjaTenue: "#fdf1e6",
  ladrillo:     "#9e3b1b",
  ladrilloTenue:"#faece6",
  verde:        "#1f7a5c",
  gris:         "#8a94a6",
  grisTenue:    "#f4f6f9",
};

// Los ocho estados de MELI con el nombre y el motivo que usa el analista de
// PNR. El texto es el de su planilla, sin reinterpretar: si la pantalla y la
// planilla dicen cosas distintas, gana la planilla y el analista deja de
// confiar en la pantalla.
//
// `grupo` es lo que agrupa las tarjetas de arriba, y responde a una sola
// pregunta: quién tiene que mover. Es la diferencia entre un caso donde hay
// algo que hacer y uno donde solo queda esperar.
const ESTADOS_PNR = [
  { clave: "WAITING_RECEIPT",  etiqueta: "Esperando comprobante",   corto: "Esperando compr.",   motivo: "Pendiente de resolución",                              grupo: "responder" },
  { clave: "TO_BILL",          etiqueta: "Con Penalidad",           corto: "Con penalidad",      motivo: "Pendiente de resolución, con probabilidad de pasar a cobro 50%", grupo: "penalidad" },
  { clave: "UPLOADED_RECEIPT", etiqueta: "Comprobante Cargado",     corto: "Compr. cargado",     motivo: "Respuesta enviada a mandante",                         grupo: "meli" },
  { clave: "ASSIGNED",         etiqueta: "Pendiente de revisión",   corto: "Pend. revisión",     motivo: "Pendiente de revisión por Mercado Libre",              grupo: "meli" },
  { clave: "ON_REVIEW",        etiqueta: "En Revisión",             corto: "En revisión",        motivo: "En revisión por Mercado Libre",                        grupo: "meli" },
  { clave: "WITHOUT_RECEIPT",  etiqueta: "Sin Comprobante Cargado", corto: "Sin comprobante",    motivo: "Sin respuesta, sin respaldo",                          grupo: "sinrespaldo" },
  { clave: "NOT_BILLED",       etiqueta: "Anulado",                 corto: "Anulado",            motivo: "Reclamo cerrado por cliente o por Mercado Libre",      grupo: "cerrado" },
  { clave: "BILLED",           etiqueta: "Enviado a Facturación",   corto: "A facturación",      motivo: "Pasa a cobro",                                         grupo: "cerrado" },
];

const POR_ESTADO = Object.fromEntries(ESTADOS_PNR.map((e) => [e.clave, e]));

// Un sub_estado que MELI invente mañana cae en "responder": aparece arriba
// pidiendo que alguien lo mire, en vez de esconderse en el medio.
function clasificar(c) {
  // La ventana gana sobre el sub_estado: un caso rescatable puede estar en
  // cualquier estado abierto, y lo que decide dónde mostrarlo no es cómo lo
  // clasifica MELI sino que el conductor esté arriba del camión ahora.
  if (c.rescatable) return "rescatable";
  const e = POR_ESTADO[c.sub_estado];
  return e ? e.grupo : "responder";
}

const GRUPOS = [
  // Rescatable no es un estado de MELI, es una ventana de tiempo: el conductor
  // sigue en calle. Va primera y siempre visible, incluso en cero — el día que
  // marque uno, el analista ya sabe dónde mirar.
  { clave: "rescatable",  etiqueta: "En ruta ahora",  nota: "se resuelve hoy",      color: "#c2410c",  tinte: "#fff1e6",       terminal: false, ventana: true },
  { clave: "responder",   etiqueta: "Por responder",  nota: "falta el comprobante", color: C.naranja,  tinte: C.naranjaTenue,  terminal: false },
  // Con Penalidad va aparte y no dentro de "Por responder" porque la acción es
  // otra: acá no se sube una foto, se pide revisión. Mezclarlos hacía que el
  // analista abriera el caso esperando cargar el comprobante y se encontrara
  // con un botón distinto.
  { clave: "penalidad",   etiqueta: "Con penalidad",  nota: "pedir revisión",       color: "#b8651c",  tinte: "#fdf3e8",       terminal: false },
  { clave: "meli",        etiqueta: "Con respaldo",   nota: "Mercado Libre revisa", color: C.navy,     tinte: C.navyTenue,     terminal: false },
  { clave: "sinrespaldo", etiqueta: "Sin respaldo",   nota: "respondido sin foto",  color: C.ladrillo, tinte: C.ladrilloTenue, terminal: true  },
  { clave: "cerrado",     etiqueta: "Cerrados",       nota: "anulados y cobrados",  color: C.verde,    tinte: "#e9f3ef",       terminal: true  },
];

const POR_CLAVE = Object.fromEntries(GRUPOS.map((g) => [g.clave, g]));

const ESTADOS = { NEW: "Nuevo", IN_PROGRESS: "En curso", CLOSED: "Cerrado" };

// Color del chip por grupo: el estado puntual lo dice el texto, el color solo
// tiene que decir si hay algo que hacer.
const COLOR_GRUPO = {
  responder: C.naranja, penalidad: "#b8651c", meli: C.navy,
  sinrespaldo: C.ladrillo, cerrado: C.verde,
};

// El color del chip y del riel sale del ESTADO, no del grupo. Con el color del
// grupo, "Enviado a Facturación" se pintaba verde por compartir la tarjeta
// "Cerrados" con "Anulado" — o sea que un caso cobrado se veía igual que uno
// ganado. El grupo dice dónde buscarlo; el color, cómo terminó.
const COLOR_ESTADO = {
  WAITING_RECEIPT:  C.naranja,
  TO_BILL:          "#b8651c",
  UPLOADED_RECEIPT: C.navy,
  ASSIGNED:         C.navy,
  ON_REVIEW:        C.navy,
  WITHOUT_RECEIPT:  C.ladrillo,
  NOT_BILLED:       C.verde,
  BILLED:           C.ladrillo,
};

function chipEstado(sub) {
  const e = POR_ESTADO[sub];
  if (!e) return { corto: sub, largo: sub, color: C.gris };
  return { corto: e.corto, largo: e.etiqueta, color: COLOR_ESTADO[sub] || C.gris };
}

// Línea de cumplimiento del caso, en el orden en que debería ocurrir. Las dos
// últimas llegan de la vista actualizada; si todavía no corriste el SQL vienen
// undefined y se pintan como pendientes, sin romper nada.
// Línea de cumplimiento del caso, en el orden en que debería ocurrir.
//
// `inferir` existe por un agujero de origen: pnr_historial_mx empezó a grabar
// el 21 de agosto a las 09:32 de México, así que todo comprobante cargado
// antes de esa hora no tiene fecha. Sin esto, un círculo hueco significaba dos
// cosas distintas —"no pasó" y "pasó pero no lo vimos"— y el analista no podía
// distinguirlas. Cuando el sub_estado prueba que el hito ocurrió, el punto se
// pinta lleno y la fecha dice "sin fecha".
//
// Solo se infiere hacia adelante y desde estados que lo garantizan: un caso en
// UPLOADED_RECEIPT tuvo comprobante, seguro. Un NOT_BILLED pudo llegar ahí sin
// comprobante —el comprador retira el reclamo— así que ahí no se infiere nada.
const HITOS = [
  { clave: "avisado_inicial_en",   etiqueta: "Aviso 1", titulo: "Primer aviso al conductor" },
  { clave: "avisado_24h_en",       etiqueta: "Aviso 2", titulo: "Escalamiento al supervisor (24 h)" },
  { clave: "avisado_final_en",     etiqueta: "Aviso 3", titulo: "Escalamiento al dueño (40 h)" },
  { clave: "pruebas_recibidas_en", etiqueta: "Pruebas", titulo: "El conductor entregó las pruebas" },
  { clave: "comprobante_en",       etiqueta: "Cargado", titulo: "Comprobante cargado en MELI",
    inferir: (c) => ["UPLOADED_RECEIPT", "ON_REVIEW", "ASSIGNED"].includes(c.sub_estado) },
];

// Una sola plantilla de columnas para la cabecera y para las filas: así no
// hay forma de que se desalineen cuando cambie un ancho.
const GRID = "14px 84px 112px minmax(118px,1fr) 122px 126px 286px 78px";

function dinero(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });
}

function fechaHito(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// El reloj no usa horas_restantes de la vista: ese número se congela en el
// momento de la consulta y a los veinte minutos ya miente. Se calcula contra
// fecha_caso con un tick propio, así el contador sube de verdad mientras el
// analista mira la pantalla.
//
// Cuenta hacia arriba, no hacia atrás, y muestra debajo cuándo nació el caso.
// El regresivo obligaba a hacer la resta de cabeza para saber de cuándo era;
// así se ven las dos cosas y la barra dice a simple vista cuánto falta.
const SLA_H = 48;

function Reloj({ c, ahora }) {
  const g = POR_CLAVE[clasificar(c)];
  if (g && g.terminal) {
    return (
      <span title="Resuelto: el SLA dejó de correr"
        style={{ fontSize: 12, color: C.gris }}>—</span>
    );
  }

  const inicio = c.fecha_caso ? new Date(c.fecha_caso).getTime() : null;
  if (!inicio) return <span style={{ fontSize: 12, color: C.gris }}>—</span>;

  const transcurrido = (ahora - inicio) / 3600000;
  const restante = SLA_H - transcurrido;
  const pct = Math.max(0, Math.min(100, (transcurrido / SLA_H) * 100));
  const color = restante < 6 ? C.ladrillo : restante < 24 ? C.naranja : C.navy;

  const h = Math.floor(transcurrido);
  const m = Math.floor((transcurrido - h) * 60);

  return (
    <span style={{ display: "block", lineHeight: 1.2 }}
      title={restante > 0
        ? `Quedan ${restante.toFixed(1)} h de las ${SLA_H}`
        : `Vencido hace ${Math.abs(restante).toFixed(1)} h`}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" }}>
        {h}:{String(m).padStart(2, "0")}
      </span>
      <span style={{ fontSize: 9.5, color: "var(--texto-tenue)" }}> / {SLA_H} h</span>
      <span style={{ display: "block", height: 3, borderRadius: 2, background: "#e6eaf1", margin: "2px 0 1px" }}>
        <span style={{ display: "block", height: 3, borderRadius: 2, width: `${pct}%`, background: color }} />
      </span>
      <span style={{ fontSize: 9, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
        {c.cuando_mx || "—"}
      </span>
    </span>
  );
}

// Cabecera que ordena. El analista preguntó dos veces cómo estaba ordenada la
// lista: si hay que explicarlo, la pantalla debería decirlo sola.
function ColOrden({ campo, orden, onClick, derecha, children }) {
  const activa = orden.campo === campo;
  return (
    <button onClick={() => onClick(campo)}
      style={{
        background: "transparent", border: "none", padding: 0, cursor: "pointer",
        font: "inherit", letterSpacing: "inherit", textTransform: "inherit",
        textAlign: derecha ? "right" : "left",
        color: activa ? C.navy : "var(--texto-tenue)",
        fontWeight: activa ? 700 : 600,
      }}>
      {children}{activa ? (orden.dir === "asc" ? " \u2191" : " \u2193") : ""}
    </button>
  );
}

function Tarjeta({ grupo, monto, casos, activa, onClick }) {
  return (
    <button onClick={onClick} title={`Ver solo ${grupo.etiqueta.toLowerCase()}`}
      style={{
        flex: 1, minWidth: 158, textAlign: "left", cursor: "pointer",
        background: activa ? grupo.tinte : "#fff",
        border: `1px solid ${activa ? grupo.color : "var(--borde)"}`,
        borderTop: `3px solid ${grupo.color}`,
        borderRadius: 12, padding: "11px 14px",
        boxShadow: activa ? `inset 0 0 0 1px ${grupo.color}` : "none",
      }}>
      <div style={{ fontSize: 10.5, color: activa ? grupo.color : "var(--texto-suave)",
        letterSpacing: 0.3, textTransform: "uppercase", fontWeight: activa ? 700 : 500 }}>
        {grupo.etiqueta}
      </div>
      <div style={{ fontSize: 23, fontWeight: 600, color: "var(--texto)", lineHeight: 1.3 }}>
        {dinero(monto)}
      </div>
      <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
        {casos} {casos === 1 ? "caso" : "casos"} · {grupo.nota}
      </div>
    </button>
  );
}

// El riel: una línea que atraviesa los cinco hitos, pintada del color del
// desenlace. El color dice cómo terminó el caso; los puntos llenos dicen por
// dónde pasó. Las dos cosas juntas son lo que enseña algo — "este se perdió
// aunque le mandamos tres avisos y subimos el comprobante" es una historia
// distinta de "este se perdió y nadie lo tocó", y en la lista se distinguen
// de un vistazo sin abrir ninguna fila.
//
// Sólido cuando el caso ya terminó, punteado mientras se mueve: un riel
// cerrado se lee como un caso cerrado.
function Riel({ c, color, terminal, fondo }) {
  return (
    <span style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>
      <span aria-hidden="true" style={{
        position: "absolute", left: "10%", right: "10%", top: 5, height: 0,
        borderTop: terminal ? `2px solid ${color}` : `2px dashed ${color}`,
        opacity: terminal ? 0.55 : 0.28,
      }} />
      {HITOS.map((h) => {
        const f = fechaHito(c[h.clave]);
        // Ocurrió, pero antes de que el historial existiera: punto lleno y
        // "sin fecha". El hecho es cierto; lo que falta es el cuándo.
        const inferido = !f && h.inferir && h.inferir(c);
        if (inferido) {
          return (
            <span key={h.clave} title={`${h.titulo}: ocurrió, sin fecha registrada`}
              style={{ position: "relative", textAlign: "center", lineHeight: 1.15, overflow: "hidden" }}>
              <span style={{
                display: "inline-block", width: 9, height: 9, borderRadius: "50%",
                background: color, border: `2px solid ${color}`, opacity: 0.55,
                boxShadow: `0 0 0 2.5px ${fondo}`, verticalAlign: "middle",
              }} />
              <div style={{ fontSize: 8, color: "var(--texto-tenue)", whiteSpace: "nowrap", marginTop: 1 }}>
                sin fecha
              </div>
            </span>
          );
        }
        // En un caso cerrado, un hito sin cumplir no está "pendiente": no va a
        // ocurrir nunca. El círculo hueco invita a esperarlo; la raya dice que
        // esa puerta ya se cerró.
        if (!f && terminal) {
          return (
            <span key={h.clave} title={`${h.titulo}: no ocurrió y ya no puede ocurrir`}
              style={{ position: "relative", textAlign: "center", lineHeight: 1.15 }}>
              <span style={{ display: "inline-block", width: 9, height: 0, verticalAlign: "middle",
                borderTop: "2px solid #c3cad6", boxShadow: `0 0 0 2.5px ${fondo}` }} />
              <div style={{ fontSize: 8.5, color: "var(--texto-tenue)", marginTop: 1 }}>{"\u00a0"}</div>
            </span>
          );
        }
        return (
          <span key={h.clave} title={f ? `${h.titulo}: ${f}` : `${h.titulo}: pendiente`}
            style={{ position: "relative", textAlign: "center", lineHeight: 1.15, overflow: "hidden" }}>
            <span style={{
              display: "inline-block", width: 9, height: 9, borderRadius: "50%",
              background: f ? color : fondo,
              border: f ? `2px solid ${color}` : "1.5px solid #cbd2dd",
              boxShadow: `0 0 0 2.5px ${fondo}`, verticalAlign: "middle",
            }} />
            <div style={{ fontSize: 8.5, color: "var(--texto-tenue)", whiteSpace: "nowrap", marginTop: 1 }}>
              {f || "\u00a0"}
            </div>
          </span>
        );
      })}
    </span>
  );
}

// Tabla de los ocho estados, con el motivo tal como lo escribió el analista.
// Reemplaza al panel que copiaba el resumen de MELI: aquel repetía un número
// que ya está a un clic en su sitio, y este dice algo que MELI no dice — qué
// significa cada estado y cuánta plata hay en cada uno.
//
// Cada fila filtra la lista. Las tarjetas de arriba sirven para entrar por
// grupo; esta tabla, para entrar por estado puntual.
function pct(n, total) {
  if (!total) return "0%";
  return ((Number(n || 0) * 100) / total).toFixed(1) + "%";
}

function TablaEstados({ casos, filtro, onFiltrar }) {
  const total = casos.length;
  let totalMonto = 0;
  const por = {};
  for (const c of casos) {
    const k = c.sub_estado || "?";
    if (!por[k]) por[k] = { n: 0, monto: 0 };
    por[k].n += 1;
    por[k].monto += Number(c.monto || 0);
    totalMonto += Number(c.monto || 0);
  }

  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12,
      overflow: "hidden", marginTop: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "210px 62px 92px 58px 1fr", gap: 10,
        padding: "7px 14px", background: C.grisTenue, borderBottom: "1px solid var(--borde)",
        fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
        color: "var(--texto-tenue)", fontWeight: 600 }}>
        <span>Estado</span>
        <span style={{ textAlign: "right" }}>Casos</span>
        <span style={{ textAlign: "right" }}>Monto</span>
        <span style={{ textAlign: "right" }}>%</span>
        <span>Motivo</span>
      </div>

      {ESTADOS_PNR.map((e) => {
        const d = por[e.clave] || { n: 0, monto: 0 };
        const activa = filtro.tipo === "estado" && filtro.valor === e.clave;
        const vacia = d.n === 0;
        return (
          <div key={e.clave} onClick={() => !vacia && onFiltrar(e.clave)}
            style={{
              display: "grid", gridTemplateColumns: "210px 62px 92px 58px 1fr", gap: 10,
              padding: "6px 14px", borderTop: "1px solid var(--borde)",
              cursor: vacia ? "default" : "pointer",
              background: activa ? C.naranjaTenue : "#fff",
              opacity: vacia ? 0.45 : 1,
            }}>
            <span style={{ fontSize: 12, fontWeight: activa ? 600 : 500,
              color: COLOR_ESTADO[e.clave] || "var(--texto)" }}>
              {e.etiqueta}
            </span>
            <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "var(--texto)",
              fontVariantNumeric: "tabular-nums" }}>{d.n}</span>
            <span style={{ textAlign: "right", fontSize: 12, color: "var(--texto)",
              fontVariantNumeric: "tabular-nums" }}>{dinero(d.monto)}</span>
            <span style={{ textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
              fontVariantNumeric: "tabular-nums" }}>{pct(d.n, total)}</span>
            <span style={{ fontSize: 11.5, color: "var(--texto-suave)", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.motivo}</span>
          </div>
        );
      })}

      {/* Total al pie. Es el número que se contrasta contra el panel de MELI:
          si los dos dicen lo mismo, el scraper trajo todo. Va acá y no en una
          tarjeta aparte porque es la suma de la columna que tiene arriba. */}
      <div style={{ display: "grid", gridTemplateColumns: "210px 62px 92px 58px 1fr", gap: 10,
        padding: "8px 14px", borderTop: `2px solid ${C.navy}`, background: C.navyTenue }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>Total</span>
        <span style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.navy,
          fontVariantNumeric: "tabular-nums" }}>{total}</span>
        <span style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: C.navy,
          fontVariantNumeric: "tabular-nums" }}>{dinero(totalMonto)}</span>
        <span style={{ textAlign: "right", fontSize: 11, color: C.navy }}>100%</span>
        <span style={{ fontSize: 11, color: "var(--texto-suave)" }}>
          Debe coincidir con el total de casos del panel de MELI para el periodo
        </span>
      </div>
    </div>
  );
}

function Dato({ etiqueta, valor }) {
  return (
    <div style={{ minWidth: 118 }}>
      <div style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase", letterSpacing: 0.3 }}>
        {etiqueta}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--texto)" }}>{valor || "—"}</div>
    </div>
  );
}

// Ficha de contacto. Nombre arriba, teléfono grande abajo: el teléfono es lo
// que el analista va a leer en voz alta o a copiar, así que es el dato con más
// peso visual de la tarjeta, no una línea más de la grilla.
function Contacto({ icono, rol, nombre, telefono, extra, alternos }) {
  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 10, padding: "8px 10px", background: "#fff" }}>
      <div style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase",
        letterSpacing: 0.3, marginBottom: 2 }}>
        {icono} {rol}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--texto)", lineHeight: 1.3 }}>{nombre || "—"}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: telefono ? C.navy : "var(--texto-tenue)",
        fontVariantNumeric: "tabular-nums", lineHeight: 1.4 }}>
        {telefono || "sin teléfono"}
      </div>
      {alternos && (
        <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>alternos: {alternos}</div>
      )}
      {extra && (
        <div style={{ fontSize: 11, color: "var(--texto-suave)", lineHeight: 1.35, marginTop: 3 }}>{extra}</div>
      )}
    </div>
  );
}

// Las pruebas que subió el supervisor, agrupadas por vuelta. El analista tiene
// que poder verlas acá: el paso siguiente es subirlas a MELI, y mandarlo a la
// bitácora con otra cuenta para mirar una foto rompe el circuito justo donde
// importa.
//
// Por vuelta y no todas juntas porque si no, seis miniaturas seguidas no dicen
// cuál fue rechazada y cuál es la respuesta al rechazo. Y el motivo de cada
// rechazo queda pegado a la vuelta que lo provocó, en vez de sobrescribirse.
//
// El bucket es privado, así que cada archivo necesita su URL firmada, que dura
// una hora.
function Miniaturas({ fotos }) {
  const [urls, setUrls] = useState({});
  const lista = Array.isArray(fotos) ? fotos : [];

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const nuevas = {};
      for (const ruta of lista) {
        if (urls[ruta]) continue;
        const { data } = await sb.storage.from("pnr-pruebas").createSignedUrl(ruta, 3600);
        if (data && data.signedUrl) nuevas[ruta] = data.signedUrl;
      }
      if (!cancelado && Object.keys(nuevas).length) setUrls((v) => ({ ...v, ...nuevas }));
    })();
    return () => { cancelado = true; };
  }, [lista.join("|")]);

  if (!lista.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {lista.map((ruta) => (
        <a key={ruta} href={urls[ruta] || "#"} target="_blank" rel="noreferrer"
          title="Abrir en tamaño completo"
          style={{ display: "block", width: 84, height: 84, borderRadius: 8, overflow: "hidden",
            border: "1px solid var(--borde)", background: "#fff" }}>
          {urls[ruta] && /\.(jpe?g|png|webp|heic)$/i.test(ruta) ? (
            <img src={urls[ruta]} alt="prueba de entrega"
              style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontSize: 10, color: "var(--texto-tenue)", padding: 5, display: "block" }}>
              {urls[ruta] ? "archivo" : "cargando…"}
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

function Pruebas({ tarea, vueltas, onRepedir }) {
  const [pidiendo, setPidiendo] = useState(false);
  const [motivo, setMotivo] = useState("");
  if (!tarea) return null;

  const vs = (vueltas || []).slice().sort((a, b) => a.vuelta - b.vuelta);
  const hayAlgo = vs.some((v) => (v.fotos || []).length > 0);
  const sinPruebas = tarea.estado === "sin_pruebas";
  const esperando = !hayAlgo && ["pendiente", "vista"].includes(tarea.estado);

  return (
    <div style={{ border: `1px solid ${sinPruebas ? C.ladrillo : hayAlgo ? C.verde : "var(--borde)"}`,
      background: sinPruebas ? C.ladrilloTenue : hayAlgo ? "#e9f3ef" : "#fff",
      borderRadius: 10, padding: "9px 11px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
        gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600,
          color: sinPruebas ? C.ladrillo : hayAlgo ? C.verde : "var(--texto-suave)" }}>
          {sinPruebas ? "El conductor no tiene pruebas" : "Pruebas del conductor"}
        </span>
        {tarea.veces_pedida > 1 && (
          <span style={{ fontSize: 10.5, color: C.ladrillo }}>
            pedida {tarea.veces_pedida} veces
          </span>
        )}
      </div>

      {esperando && (
        <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>
          {tarea.estado === "vista"
            ? `${tarea.supervisor_nombre || tarea.sc} abrió la tarea y todavía no sube nada.`
            : `Pedida a ${tarea.supervisor_nombre || tarea.sc}, sin abrir aún.`}
        </div>
      )}

      {vs.map((v) => (
        <div key={v.vuelta} style={{
          borderTop: v.vuelta > 1 ? "1px solid var(--borde)" : "none",
          paddingTop: v.vuelta > 1 ? 8 : 0, marginTop: v.vuelta > 1 ? 8 : 0,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--texto-suave)" }}>
              Vuelta {v.vuelta}
            </span>
            <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
              {fechaHito(v.entregado_en) || "sin entrega"}
            </span>
            {v.vision_puntaje != null && (
              <span title={v.vision_nota || ""}
                style={{ fontSize: 10, fontWeight: 600, borderRadius: 20, padding: "0 7px",
                  color: v.vision_puntaje >= 70 ? C.verde : v.vision_puntaje >= 40 ? C.naranja : C.ladrillo,
                  border: `1px solid ${v.vision_puntaje >= 70 ? C.verde : v.vision_puntaje >= 40 ? C.naranja : C.ladrillo}` }}>
                Vision {v.vision_puntaje}
              </span>
            )}
            {v.rechazada_en && (
              <span style={{ fontSize: 10, color: C.ladrillo }}>
                rechazada · {v.motivo_rechazo}
              </span>
            )}
          </div>
          <Miniaturas fotos={v.fotos} />
          {v.comentario && (
            <div style={{ fontSize: 12, color: "var(--texto)", lineHeight: 1.4, marginTop: 5 }}>
              “{v.comentario}”
            </div>
          )}
        </div>
      ))}

      {/* Volver a pedir. El motivo es obligatorio: "manda otra" sin decir qué
          falta hace que el supervisor mande lo mismo, y se pierde otro turno
          del reloj. */}
      {(hayAlgo || sinPruebas) && (
        pidiendo ? (
          <div style={{ marginTop: 8 }}>
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)}
              placeholder="Qué falta: por ejemplo, no se ve el número de la casa"
              style={{ width: "100%", fontSize: 12, padding: "6px 9px", borderRadius: 8,
                border: "1px solid var(--borde)", marginBottom: 6 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => { onRepedir(tarea, motivo.trim()); setPidiendo(false); setMotivo(""); }}
                disabled={motivo.trim().length < 4}
                style={{ fontSize: 11.5, padding: "5px 11px", borderRadius: 8,
                  cursor: motivo.trim().length < 4 ? "default" : "pointer",
                  border: `1px solid ${motivo.trim().length < 4 ? "var(--borde)" : C.naranja}`,
                  background: motivo.trim().length < 4 ? "#fff" : C.naranja,
                  color: motivo.trim().length < 4 ? "var(--texto-tenue)" : "#fff" }}>
                Pedir de nuevo
              </button>
              <button onClick={() => { setPidiendo(false); setMotivo(""); }}
                style={{ fontSize: 11.5, padding: "5px 11px", borderRadius: 8,
                  border: "1px solid var(--borde)", background: "#fff", cursor: "pointer" }}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setPidiendo(true)}
            style={{ marginTop: 8, fontSize: 11.5, padding: "5px 11px", borderRadius: 8,
              border: "1px solid var(--borde)", background: "#fff",
              color: "var(--texto-suave)", cursor: "pointer" }}>
            Estas pruebas no sirven, pedir otras
          </button>
        )
      )}
    </div>
  );
}

function Detalle({ c, onPedir, trayendo, supervisor, tarea, vueltas, onTareaCreada, onRepedir, onNotificar }) {
  const [panel, setPanel] = useState(false);
  const [creando, setCreando] = useState(false);
  const [errorTarea, setErrorTarea] = useState("");
  const [envio, setEnvio] = useState(null);

  // El supervisor se copia en la fila en vez de resolverse por join al leerla:
  // si mañana cambia el supervisor del centro, la tarea vieja tiene que seguir
  // diciendo a quién se le pidió, no a quién le tocaría hoy.
  async function crearTarea() {
    if (!supervisor) return;
    setCreando(true);
    setErrorTarea("");
    setEnvio(null);

    const { data, error } = await sb.from("pnr_tareas_mx").insert({
      case_id: c.case_id,
      sc: c.service_center,
      supervisor_nombre: supervisor.supervisor_nombre,
      supervisor_email: supervisor.supervisor_email,
      supervisor_telefono: supervisor.supervisor_telefono,
      creada_por: "posventa",
    }).select().single();

    if (error) {
      // El índice único deja una sola tarea viva por caso. Si ya existe, no es
      // un error que el analista tenga que entender: es que alguien ya la pidió.
      setErrorTarea(/duplicate|unique/i.test(error.message)
        ? "Ya hay una tarea abierta para este caso."
        : error.message);
      setCreando(false);
      return;
    }
    if (onTareaCreada) onTareaCreada(data);

    // La tarea ya quedó. Los avisos van después y su resultado se muestra
    // aparte: si n8n falla, el supervisor igual tiene la tarea en su bitácora
    // y el analista sabe que le tiene que avisar por otro lado.
    const r = onNotificar ? await onNotificar(cuerpoAviso()) : { ok: false, error: "sin envío" };
    setEnvio(r);
    setCreando(false);
  }

  // Reintento de los avisos cuando la tarea ya existe.
  async function soloNotificar() {
    setCreando(true);
    setEnvio(null);
    const r = onNotificar ? await onNotificar(cuerpoAviso()) : { ok: false, error: "sin envío" };
    setEnvio(r);
    setCreando(false);
  }

  // Todo lo que n8n necesita para armar los mensajes. Va en el cuerpo del
  // webhook en vez de que n8n lo consulte, que era el diseño anterior: para la
  // demostración eso ahorra la clave de Supabase y un nodo. La contra es que
  // estos datos son los que el navegador tenía cargados, y si la fila cambió
  // hace un rato el mensaje sale con lo viejo.
  function cuerpoAviso() {
    return {
      case_id: c.case_id,
      analista: "posventa",
      sc: c.service_center,
      conductor: c.transportista || c.conductor_ruta || c.conductor,
      telefono_conductor: c.telefono || c.telefono_ruta,
      supervisor_nombre: supervisor ? supervisor.supervisor_nombre : null,
      supervisor_telefono: supervisor ? supervisor.supervisor_telefono : null,
      supervisor_email: supervisor ? supervisor.supervisor_email : null,
      route_id: c.route_id,
      fecha_ruta: c.fecha_ruta,
      shipment_id: c.shipment_id,
      producto: c.producto,
      monto: c.monto,
      reclamante: c.reclamante || c.designado_recibir,
      telefono_reclamante: c.telefono_reclamante,
      direccion_entrega: c.direccion_entrega,
      entregado_en: c.entregado_en,
      recibio_quien: c.recibio_quien,
      recibio_nombre: c.recibio_nombre,
      distancia_texto: c.distancia_texto,
    };
  }

  const hayDetalle = !!c.detalle_capturado_en && !c.detalle_error;

  // La defensa del caso en una línea. Si MELI registró la entrega en el
  // domicilio exacto y con constancia de quién recibió, el reclamo se pelea
  // solo — y eso hoy el analista lo descubre abriendo MELI caso por caso.
  const enDomicilio = /^A\s*0([.,]0+)?\s*km/i.test(c.distancia_texto || "");
  const conConstancia = !!c.recibio_quien;
  const defendible = enDomicilio && conConstancia;

  const marco = defendible
    ? { borde: C.verde, fondo: "#e9f3ef", texto: C.verde }
    : conConstancia
      ? { borde: "var(--borde)", fondo: "#fff", texto: "var(--texto-suave)" }
      : { borde: C.naranja, fondo: C.naranjaTenue, texto: C.naranja };

  return (
    <div style={{ padding: "12px 16px 14px 44px", background: C.grisTenue, borderTop: "1px solid var(--borde)" }}>
      {c.rescatable && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
          background: "#fff1e6", border: "1px solid #c2410c", borderRadius: 10, padding: "7px 11px" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c2410c" }}>
            El conductor está en ruta ahora
          </span>
          <span style={{ fontSize: 11.5, color: "#8a3208" }}>
            Ruta {c.route_code} del {c.fecha_ruta} · {c.estado_ruta}
            {c.ruta_vista_en ? ` · vista ${fechaHito(c.ruta_vista_en)}` : ""}
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.7fr) minmax(240px,1fr)", gap: 12 }}>

        {/* Izquierda: los hechos del caso */}
        <div>
          <div style={{ border: "1px solid var(--borde)", borderRadius: 10, background: "#fff",
            padding: "9px 11px", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)" }}>Caso y reclamo</span>
              <span style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>
                {c.case_id} · guía {c.shipment_id}
              </span>
            </div>
            {c.producto && (
              <div style={{ fontSize: 13.5, color: "var(--texto)", lineHeight: 1.35, marginBottom: 6 }}>
                {c.producto}
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <Dato etiqueta="Valor" valor={c.valor_compra != null ? dinero(c.valor_compra) : dinero(c.monto)} />
              <Dato etiqueta="Nace" valor={c.cuando_mx} />
              <Dato etiqueta="Centro" valor={c.service_center} />
              <Dato etiqueta="Ruta" valor={`${c.route_code || "—"} · ${c.route_id || "—"}`} />
              <Dato etiqueta="Estado MELI" valor={(POR_ESTADO[c.sub_estado] || {}).etiqueta} />
              <Dato etiqueta="Responsable" valor={c.responsable} />
            </div>
            {c.mensaje_reclamo && (
              <div style={{ marginTop: 7, fontSize: 12.5, color: "var(--texto)", background: C.grisTenue,
                borderRadius: 8, padding: "6px 9px" }}>
                “{c.mensaje_reclamo}”
              </div>
            )}
          </div>

          {/* Prueba de entrega. El color lo dice antes que el texto: verde si
              hay constancia y la entrega fue en el domicilio, naranja si no hay
              constancia de nada. Es la única parte de la fila que decide si el
              caso se pelea o se paga. */}
          <div style={{ border: `1px solid ${marco.borde}`, background: marco.fondo,
            borderRadius: 10, padding: "9px 11px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: marco.texto, marginBottom: 6 }}>
              Prueba de entrega
              {defendible && " · entregado en el domicilio y con constancia"}
              {!conConstancia && hayDetalle && " · sin constancia de quién recibió"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <Dato etiqueta="Entregado" valor={c.entregado_en} />
              <Dato etiqueta="Recibió" valor={c.recibio_quien} />
              <Dato etiqueta="Nombre" valor={c.recibio_nombre} />
              <Dato etiqueta="Documento" valor={c.recibio_documento} />
              <Dato etiqueta="Distancia" valor={c.distancia_texto} />
            </div>
          </div>

          <Pruebas tarea={tarea} vueltas={vueltas} onRepedir={onRepedir} />
        </div>

        {/* Derecha: a quién llamar y el botón que lo dispara */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Contacto icono="🚚" rol="Conductor"
            nombre={c.transportista || c.conductor_ruta || c.conductor}
            telefono={c.telefono || c.telefono_ruta}
            extra={[c.patente, c.transportadora].filter(Boolean).join(" · ")} />

          <Contacto icono="👤" rol="Reclamante"
            nombre={c.reclamante || c.designado_recibir}
            telefono={c.telefono_reclamante}
            alternos={c.telefonos_alternos}
            extra={c.direccion_entrega} />

          {/* El cumplimiento estaba como bloque propio y repetía el riel de la
              fila. Acá va comprimido y junto al botón, que es donde importa:
              saber a quién ya se le avisó antes de volver a avisarle. */}
          <div style={{ border: "1px solid var(--borde)", borderRadius: 10, background: "#fff", padding: "7px 10px" }}>
            {HITOS.map((h) => {
              const f = fechaHito(c[h.clave]);
              const inferido = !f && h.inferir && h.inferir(c);
              return (
                <div key={h.clave} style={{ display: "flex", justifyContent: "space-between",
                  alignItems: "baseline", gap: 8, padding: "1.5px 0" }}>
                  <span style={{ fontSize: 11, color: "var(--texto-suave)" }}>{h.etiqueta}</span>
                  <span title={inferido ? "Ocurrió antes de que se registrara el historial" : ""}
                    style={{ fontSize: 10.5, fontVariantNumeric: "tabular-nums",
                      color: f ? C.verde : inferido ? "var(--texto-suave)" : "var(--texto-tenue)" }}>
                    {f || (inferido ? "sí, sin fecha" : "pendiente")}
                  </span>
                </div>
              );
            })}
          </div>

          <button onClick={() => setPanel((v) => !v)}
            style={{ fontSize: 13, fontWeight: 600, padding: "9px 14px", borderRadius: 9,
              border: `1px solid ${C.naranja}`, background: panel ? C.naranjaTenue : C.naranja,
              color: panel ? C.naranja : "#fff", cursor: "pointer" }}>
            {panel ? "Cerrar" : "Notificar"}
          </button>

          {panel && (
            <div style={{ border: "1px solid var(--borde)", borderRadius: 10, background: "#fff", padding: "9px 11px" }}>
              {tarea ? (
                <Fragment>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: C.verde, marginBottom: 4 }}>
                    Tarea creada
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--texto-suave)", lineHeight: 1.4 }}>
                    {tarea.supervisor_nombre || tarea.sc} la tiene en su bitácora desde
                    {" "}{fechaHito(tarea.creada_en)}. Estado: {tarea.estado}.
                  </div>
                  <button onClick={soloNotificar} disabled={creando}
                    style={{ width: "100%", marginTop: 8, fontSize: 11.5, padding: "6px 10px",
                      borderRadius: 8, cursor: "pointer", border: "1px solid var(--borde)",
                      background: "#fff", color: "var(--texto-suave)" }}>
                    {creando ? "Enviando…" : "Volver a enviar los avisos"}
                  </button>
                  {(tarea.fotos || []).length > 0 && (
                    <div style={{ fontSize: 11.5, color: C.verde, marginTop: 4 }}>
                      {tarea.fotos.length} {tarea.fotos.length === 1 ? "foto" : "fotos"} cargadas
                    </div>
                  )}
                  {tarea.comentario && (
                    <div style={{ fontSize: 11.5, color: "var(--texto)", marginTop: 4 }}>
                      “{tarea.comentario}”
                    </div>
                  )}
                </Fragment>
              ) : (
                <Fragment>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--texto-suave)", marginBottom: 6 }}>
                    Se le pide la foto de la entrega a
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--texto)" }}>
                    {supervisor ? supervisor.supervisor_nombre : `Sin supervisor para ${c.service_center}`}
                  </div>
                  {supervisor && (
                    <div style={{ fontSize: 11, color: "var(--texto-tenue)", lineHeight: 1.4 }}>
                      {supervisor.supervisor_email}
                      {supervisor.supervisor_telefono ? ` · ${supervisor.supervisor_telefono}` : " · sin teléfono"}
                    </div>
                  )}
                  {/* El correo y el WhatsApp vienen después. Se listan en gris
                      para que el analista sepa qué pasa y qué no: prometer un
                      correo que no sale es peor que no mencionarlo. */}
                  <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 6, lineHeight: 1.4 }}>
                    Se crea la tarea en la bitácora y salen tres avisos: WhatsApp al conductor,
                    WhatsApp al supervisor y correo al supervisor.
                  </div>
                  <button onClick={crearTarea} disabled={!supervisor || creando}
                    style={{ width: "100%", marginTop: 8, fontSize: 12.5, fontWeight: 600,
                      padding: "8px 10px", borderRadius: 8, cursor: supervisor ? "pointer" : "default",
                      border: `1px solid ${supervisor ? C.naranja : "var(--borde)"}`,
                      background: supervisor ? C.naranja : "#fff",
                      color: supervisor ? "#fff" : "var(--texto-tenue)" }}>
                    {creando ? "Creando y enviando…" : "Crear la tarea y avisar"}
                  </button>
                  {errorTarea && (
                    <div style={{ fontSize: 11, color: C.ladrillo, marginTop: 6 }}>{errorTarea}</div>
                  )}
                </Fragment>
              )}

              {/* A qué número salió cada aviso. Es la primera pregunta cuando el
                  conductor no responde, y sin esto habría que ir a mirar los
                  registros de n8n para contestarla. */}
              {envio && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--borde)",
                  fontSize: 11, lineHeight: 1.5,
                  color: envio.ok ? C.verde : C.ladrillo }}>
                  {envio.ok ? (
                    <Fragment>
                      <div style={{ fontWeight: 600 }}>Avisos enviados</div>
                      <div style={{ color: "var(--texto-suave)" }}>
                        Conductor {envio.conductor || "—"}<br />
                        Supervisor {envio.supervisor || "—"}<br />
                        Correo {envio.correo || "—"}
                        {envio.modo_prueba ? " · modo prueba" : ""}
                      </div>
                    </Fragment>
                  ) : (
                    <Fragment>
                      <div style={{ fontWeight: 600 }}>No se pudieron enviar los avisos</div>
                      <div>{envio.error}</div>
                      <div style={{ color: "var(--texto-suave)" }}>
                        La tarea sí quedó creada en la bitácora.
                      </div>
                    </Fragment>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>
              {hayDetalle ? `detalle de ${fechaHito(c.detalle_capturado_en)}` : "sin detalle de MELI"}
            </span>
            <button onClick={() => onPedir(c.case_id, true)} disabled={trayendo}
              title="Volver a leer el caso en MELI"
              style={{ fontSize: 11, padding: "3px 9px" }}>
              {trayendo ? "trayendo…" : "actualizar"}
            </button>
          </div>
        </div>
      </div>

      {c.detalle_error && (
        <div style={{ fontSize: 11.5, color: C.ladrillo, background: C.ladrilloTenue,
          border: `1px solid ${C.ladrillo}`, borderRadius: 8, padding: "6px 10px", marginTop: 8 }}>
          No se pudo traer el detalle de MELI: {c.detalle_error}
        </div>
      )}
    </div>
  );
}

function Fila({ c, abierta, onAbrir, onPedir, trayendo, ahora, supervisor, tarea, vueltas, onTareaCreada, onRepedir, onNotificar }) {
  const g = POR_CLAVE[clasificar(c)];
  const fondo = abierta ? C.grisTenue : "#fff";
  const sub = chipEstado(c.sub_estado);
  return (
    <Fragment>
      <div onClick={onAbrir} style={{
        display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 10,
        padding: "8px 16px", borderTop: "1px solid var(--borde)", cursor: "pointer",
        background: abierta ? C.grisTenue : "#fff",
      }}>
        <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}>{abierta ? "▾" : "▸"}</span>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)", fontVariantNumeric: "tabular-nums" }}>
          {c.case_id}
        </span>
        <Reloj c={c} ahora={ahora} />
        <span style={{ minWidth: 0, fontSize: 13, color: "var(--texto)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.rescatable && (
            <span title="La ruta de este caso sigue en calle: el conductor puede resolverlo ahora"
              style={{ display: "inline-block", fontSize: 9.5, fontWeight: 700, color: "#c2410c",
                background: "#fff1e6", border: "1px solid #c2410c", borderRadius: 4,
                padding: "0 5px", marginRight: 6, verticalAlign: "middle" }}>
              EN RUTA
            </span>
          )}
          {c.conductor || "Sin conductor"}
        </span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.route_code} · {c.service_center}
        </span>
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: sub.color, border: `1px solid ${sub.color}`,
          borderRadius: 20, padding: "1px 7px", textAlign: "center", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>{sub.corto}</span>
        <Riel c={c} color={COLOR_ESTADO[c.sub_estado] || g.color} terminal={g.terminal} fondo={fondo} />
        <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
          {dinero(c.monto)}
        </span>
      </div>
      {abierta && <Detalle c={c} onPedir={onPedir} trayendo={trayendo} supervisor={supervisor}
        tarea={tarea} vueltas={vueltas} onTareaCreada={onTareaCreada} onRepedir={onRepedir}
        onNotificar={onNotificar} />}
    </Fragment>
  );
}

export default function Posventa() {
  const [vista, setVista] = useState("pnr");
  const [casos, setCasos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [filtro, setFiltro] = useState({ tipo: "grupo", valor: "responder" });
  const [periodo, setPeriodo] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [abiertas, setAbiertas] = useState(new Set());
  const [aviso, setAviso] = useState("");
  const [trayendo, setTrayendo] = useState(new Set());
  const [ahora, setAhora] = useState(() => Date.now());
  const [orden, setOrden] = useState({ campo: "sla", dir: "asc" });
  const [supervisores, setSupervisores] = useState({});
  const [tareas, setTareas] = useState({});
  const [vueltas, setVueltas] = useState({});

  async function cargar() {
    setError(null);
    const [tablero, sup] = await Promise.all([
      sb.from("vw_pnr_detalle").select("*").limit(5000),
      // Los supervisores se leen una vez por carga: son diez centros y cambian
      // poco. Sirven para saber a quién le va la tarea del escalamiento sin
      // pedirlo caso por caso.
      sb.from("vw_pnr_supervisor").select("*"),
    ]);
    // Las tareas vivas del periodo, para que el panel muestre si ya se pidió la
    // foto y en qué quedó, en vez de ofrecer crearla otra vez.
    const [tar, vlt] = await Promise.all([
      sb.from("pnr_tareas_mx")
        .select("id, case_id, sc, estado, supervisor_nombre, creada_en, fotos, comentario, veces_pedida, motivo_reabrir")
        .in("estado", ["pendiente", "vista", "completada", "sin_pruebas"])
        .limit(5000),
      sb.from("pnr_tareas_vueltas").select("*").order("vuelta").limit(5000),
    ]);
    if (tablero.error) setError(tablero.error.message);
    else setCasos(tablero.data || []);
    if (!sup.error && sup.data) {
      const m = {};
      for (const f of sup.data) if (f.estacion_origen) m[f.estacion_origen] = f;
      setSupervisores(m);
    }
    if (!tar.error && tar.data) {
      const m = {};
      for (const f of tar.data) m[f.case_id] = f;
      setTareas(m);
    }
    if (!vlt.error && vlt.data) {
      const m = {};
      for (const f of vlt.data) {
        if (!m[f.case_id]) m[f.case_id] = [];
        m[f.case_id].push(f);
      }
      setVueltas(m);
    }
    setCargando(false);
  }

  // Realtime sobre pnr_tareas_mx. Sin esto el analista tenía que apretar
  // Actualizar para saber que el supervisor ya subió la foto, y en la práctica
  // no lo aprieta: se entera al rato o no se entera.
  //
  // El hito pruebas_recibidas_en lo escribe un trigger sobre pnr_casos_mx, que
  // no se publica por Realtime — el scraper la reescribe entera cada 5 minutos
  // y mandaría cien eventos por ciclo. Así que cuando llega el evento de la
  // tarea, se relee ese único caso.
  useEffect(() => {
    const canal = sb.channel("pnr-tareas-posventa")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pnr_tareas_mx" },
        async (payload) => {
          const fila = payload.new && payload.new.case_id ? payload.new : payload.old;
          if (!fila || !fila.case_id) return;

          if (payload.eventType === "DELETE") {
            setTareas((prev) => {
              const n = { ...prev };
              delete n[fila.case_id];
              return n;
            });
          } else {
            setTareas((prev) => ({ ...prev, [fila.case_id]: fila }));
          }

          const { data } = await sb.from("vw_pnr_detalle")
            .select("case_id, pruebas_recibidas_en, sub_estado")
            .eq("case_id", fila.case_id)
            .maybeSingle();
          if (data) {
            setCasos((prev) => prev.map((x) => x.case_id === data.case_id
              ? { ...x, pruebas_recibidas_en: data.pruebas_recibidas_en, sub_estado: data.sub_estado }
              : x));
          }
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pnr_tareas_vueltas" },
        (payload) => {
          const v = payload.new && payload.new.case_id ? payload.new : payload.old;
          if (!v || !v.case_id) return;
          setVueltas((prev) => {
            const lista = (prev[v.case_id] || []).filter((x) => x.id !== v.id);
            if (payload.eventType !== "DELETE") lista.push(v);
            lista.sort((a, b) => a.vuelta - b.vuelta);
            return { ...prev, [v.case_id]: lista };
          });
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, []);

  // Un tick por minuto mueve todos los relojes sin volver a consultar la base.
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    cargar();
    // pnr-mx.cjs corre cada 5 min; refrescar cada 3 alcanza para no mirar
    // datos viejos sin castigar la base.
    const t = setInterval(cargar, 180000);
    return () => clearInterval(t);
  }, []);

  const periodos = useMemo(() => {
    const s = [...new Set(casos.map((c) => c.periodo).filter(Boolean))];
    return s.sort().reverse();
  }, [casos]);

  // Si todavía no se eligió periodo, se toma el más nuevo apenas llegan datos.
  useEffect(() => {
    if (!periodo && periodos.length) setPeriodo(periodos[0]);
  }, [periodos, periodo]);

  const delPeriodo = useMemo(
    () => casos.filter((c) => !periodo || c.periodo === periodo),
    [casos, periodo]
  );

  const totales = useMemo(() => {
    const t = {};
    for (const g of GRUPOS) t[g.clave] = { monto: 0, n: 0 };
    for (const c of delPeriodo) {
      const k = clasificar(c);
      t[k].monto += Number(c.monto || 0);
      t[k].n += 1;
    }
    return t;
  }, [delPeriodo]);

  const buscando = busqueda.trim().length > 0;

  const subEstadosDelGrupo = useMemo(
    () => filtro.tipo === "grupo"
      ? ESTADOS_PNR.filter((e) => e.grupo === filtro.valor)
      : [],
    [filtro]
  );

  // La búsqueda ignora periodo y tarjeta a propósito: cuando alguien pega un
  // número de caso quiere ese caso, no "ese caso si además está en la
  // quincena y el grupo que tenía abiertos".
  const lista = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = buscando
      ? casos.filter((c) =>
          [c.case_id, c.shipment_id, c.route_code, c.route_id, c.conductor, c.service_center, c.patente]
            .some((v) => String(v || "").toLowerCase().includes(q)))
      : delPeriodo.filter((c) => {
          if (filtro.tipo === "todos") return true;
          if (filtro.tipo === "estado") return c.sub_estado === filtro.valor;
          return clasificar(c) === filtro.valor;
        });

    // Orden simple y predecible: por defecto el más viejo arriba, que es el
    // que más cerca está de perderse. La versión anterior mandaba los vencidos
    // al fondo razonando que el SLA ya no los distingue, y con eso escondía un
    // caso de $1.655 con 145 horas debajo de uno de $69 con media hora. Un
    // caso vencido sigue abierto en MELI y sigue siendo plata que se puede
    // pelear; que el reloj se haya pasado no lo vuelve menos urgente.
    const valor = (c) => {
      if (orden.campo === "monto") return Number(c.monto || 0);
      if (orden.campo === "caso") return Number(c.case_id || 0);
      return c.horas_restantes == null ? 9999 : Number(c.horas_restantes);
    };
    // Los rescatables van arriba de todo, por encima del orden que elija el
    // analista. Es lo único de esta pantalla que se pierde por esperar: dentro
    // de unas horas la ruta cierra y el caso pasa a costar días de gestión.
    return base.slice().sort((a, b) => {
      if (!!a.rescatable !== !!b.rescatable) return a.rescatable ? -1 : 1;
      const d = valor(a) - valor(b);
      return orden.dir === "asc" ? d : -d;
    });
  }, [casos, delPeriodo, filtro, busqueda, buscando, orden]);

  function ordenar(campo) {
    setOrden((o) => o.campo === campo
      ? { campo, dir: o.dir === "asc" ? "desc" : "asc" }
      : { campo, dir: campo === "monto" ? "desc" : "asc" });
    setAbiertas(new Set());
  }

  // Se llama al desplegar la fila y desde el botón. Sin secreto configurado no
  // intenta: mejor un aviso claro que un fetch que falla en silencio.
  async function pedirDetalle(caseId, forzar) {
    if (!SECRETO_PNR) {
      setAviso("Falta VITE_PNR_API_SECRET");
      setTimeout(() => setAviso(""), 2500);
      return;
    }
    setTrayendo((prev) => new Set(prev).add(caseId));
    try {
      const r = await fetch(`${API_PNR}/pnr-detalle/${caseId}${forzar ? "?forzar=1" : ""}`,
        { headers: { "x-api-secret": SECRETO_PNR } });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "sin detalle");
      // Se mezcla en memoria en vez de recargar toda la lista: la fila está
      // abierta y una recarga la cerraría de golpe delante del analista.
      setCasos((prev) => prev.map((x) => x.case_id === caseId
        ? { ...x, ...soloDetalle(j.detalle),
            detalle_capturado_en: j.detalle.capturado_en,
            detalle_error: j.detalle.error || null }
        : x));
    } catch (e) {
      setCasos((prev) => prev.map((x) => x.case_id === caseId
        ? { ...x, detalle_error: String(e.message || e) } : x));
    } finally {
      setTrayendo((prev) => { const n = new Set(prev); n.delete(caseId); return n; });
    }
  }

  // Varias filas pueden quedar abiertas: el analista compara casos del mismo
  // conductor o de la misma ruta, y cerrarle la anterior cada vez lo obliga a
  // memorizar lo que acaba de leer.
  // Dispara los avisos. Es un paso aparte de crear la tarea a propósito: la
  // tarea es lo que queda registrado y el aviso es lo que puede fallar. Si se
  // hicieran juntos y n8n estuviera caído, el analista no sabría si la tarea
  // quedó creada o no, y volvería a apretar.
  async function notificar(datos) {
    if (!WEBHOOK_NOTIFICAR) {
      setAviso("Falta VITE_PNR_WEBHOOK");
      setTimeout(() => setAviso(""), 3000);
      return { ok: false, error: "sin webhook configurado" };
    }
    try {
      const r = await fetch(WEBHOOK_NOTIFICAR, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // El secreto viaja en el JavaScript del navegador igual que la URL, así
          // que no es una defensa fuerte: sirve para que conocer la dirección no
          // alcance, y para poder rotarlo sin tocar el flujo de n8n.
          ...(WEBHOOK_SECRETO ? { "x-pnr-secret": WEBHOOK_SECRETO } : {}),
        },
        body: JSON.stringify(datos),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) {
        throw new Error("n8n rechazó la llamada: revisa VITE_PNR_WEBHOOK_SECRET");
      }
      if (!r.ok || j.ok === false) throw new Error(j.error || `n8n respondió ${r.status}`);
      // n8n devuelve los destinos que usó de verdad. Mostrarlos es lo único que
      // le dice al analista a qué número salió, que es la primera pregunta
      // cuando el conductor no responde.
      return { ok: true, ...j };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // Reabrir no borra las fotos rechazadas: son el registro de qué se mandó y
  // por qué no alcanzó. Si se borraran, la próxima discusión empieza de cero.
  async function repedirPruebas(t, motivo) {
    if (!t || !motivo) return;
    const { data, error } = await sb.from("pnr_tareas_mx").update({
      estado: "pendiente",
      vista_en: null,
      completada_en: null,
      reabierta_en: new Date().toISOString(),
      reabierta_por: "posventa",
      motivo_reabrir: motivo,
      veces_pedida: (t.veces_pedida || 1) + 1,
    }).eq("id", t.id).select().single();
    if (!error && data) setTareas((prev) => ({ ...prev, [data.case_id]: data }));
  }

  function agregarTarea(t) {
    if (t) setTareas((prev) => ({ ...prev, [t.case_id]: t }));
  }

  function abrirFila(c) {
    const estaba = abiertas.has(c.case_id);
    setAbiertas((prev) => {
      const n = new Set(prev);
      if (estaba) n.delete(c.case_id); else n.add(c.case_id);
      return n;
    });
    if (!estaba && !detalleFresco(c) && !trayendo.has(c.case_id)) pedirDetalle(c.case_id, false);
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 20px", background: "var(--fondo, #f4f6f9)" }}>
      {/* Encabezado */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.navy }}>Posventa</h2>
        <div style={{ display: "flex", gap: 4 }}>
          {VISTAS.map((v) => (
            <button key={v.clave} onClick={() => v.activa && setVista(v.clave)} disabled={!v.activa}
              title={v.activa ? "" : "Todavía no disponible"}
              style={{
                fontSize: 12.5, padding: "5px 12px", borderRadius: 7,
                cursor: v.activa ? "pointer" : "default",
                border: "1px solid " + (vista === v.clave ? C.navy : "var(--borde)"),
                background: vista === v.clave ? C.navy : "#fff",
                color: vista === v.clave ? "#fff" : v.activa ? "var(--texto)" : "var(--texto-tenue)",
              }}>
              {v.etiqueta}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {aviso && <span style={{ fontSize: 11.5, color: C.verde }}>{aviso}</span>}
          <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); setAbiertas(new Set()); }}
            placeholder="Buscar caso, guía, ruta o conductor"
            style={{ fontSize: 12.5, padding: "5px 10px", borderRadius: 7,
              border: "1px solid var(--borde)", width: 250 }} />
          {buscando && (
            <button onClick={() => setBusqueda("")} style={{ fontSize: 11.5, padding: "5px 9px" }}>Limpiar</button>
          )}
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} disabled={buscando}
            title={buscando ? "La búsqueda recorre todos los periodos" : ""}
            style={{ fontSize: 12.5, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--borde)" }}>
            {periodos.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={cargar} style={{ fontSize: 11.5, padding: "5px 11px" }}>Actualizar</button>
        </div>
      </div>

      {error && (
        <div style={{ background: C.ladrilloTenue, border: `1px solid ${C.ladrillo}`, color: C.ladrillo,
          borderRadius: 10, padding: "10px 14px", fontSize: 12.5, marginBottom: 14 }}>
          No se pudo leer vw_pnr_detalle: {error}
        </div>
      )}

      {/* Las tarjetas son el filtro. Un tablero de plata donde el número y el
          botón que lo abre son la misma cosa: se toca el monto que interesa y
          la lista de abajo queda con esos casos. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        {GRUPOS.map((g) => (
          <Tarjeta key={g.clave} grupo={g} monto={totales[g.clave].monto} casos={totales[g.clave].n}
            activa={!buscando && filtro.tipo === "grupo" && filtro.valor === g.clave}
            onClick={() => { setBusqueda(""); setFiltro({ tipo: "grupo", valor: g.clave }); setAbiertas(new Set()); }} />
        ))}
      </div>

      {/* Mismo formato que el panel de MELI, con los números de nuestra base. */}
      <TablaEstados casos={delPeriodo} filtro={filtro}
        onFiltrar={(clave) => { setBusqueda(""); setFiltro({ tipo: "estado", valor: clave }); setAbiertas(new Set()); }} />

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
            {buscando ? "Resultados"
              : filtro.tipo === "estado" ? (POR_ESTADO[filtro.valor] || {}).etiqueta || "Casos"
              : filtro.tipo === "todos" ? "Todos"
              : (POR_CLAVE[filtro.valor] || {}).etiqueta || "Casos"}
          </span>
          {/* Sub-filtros del grupo abierto. "Cerrados" junta anulados y cobrados,
              y son lo opuesto entre sí: hacía falta poder verlos por separado
              sin bajar a la tabla. Aparecen solo cuando el grupo tiene más de
              un estado, así no ensucian los que tienen uno solo. */}
          {!buscando && filtro.tipo === "grupo" && subEstadosDelGrupo.length > 1 && (
            <div style={{ display: "flex", gap: 4 }}>
              {subEstadosDelGrupo.map((e) => (
                <button key={e.clave}
                  onClick={() => { setFiltro({ tipo: "estado", valor: e.clave }); setAbiertas(new Set()); }}
                  style={{
                    fontSize: 11, padding: "3px 9px", borderRadius: 20, cursor: "pointer",
                    border: `1px solid ${COLOR_ESTADO[e.clave] || "var(--borde)"}`,
                    background: "#fff", color: COLOR_ESTADO[e.clave] || "var(--texto-suave)",
                  }}>
                  {e.corto}
                </button>
              ))}
            </div>
          )}

          {/* Al filtrar por un estado puntual, un atajo para volver al grupo. */}
          {!buscando && filtro.tipo === "estado" && (
            <button onClick={() => {
              const g = (POR_ESTADO[filtro.valor] || {}).grupo;
              setFiltro(g ? { tipo: "grupo", valor: g } : { tipo: "todos", valor: null });
              setAbiertas(new Set());
            }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 20, cursor: "pointer",
              border: "1px solid var(--borde)", background: "#fff", color: "var(--texto-suave)" }}>
              ← todo el grupo
            </button>
          )}

          <button onClick={() => { setBusqueda(""); setFiltro({ tipo: "todos", valor: null }); setAbiertas(new Set()); }}
            style={{
              fontSize: 11.5, padding: "4px 10px", borderRadius: 20, cursor: "pointer",
              border: "1px solid " + (!buscando && filtro.tipo === "todos" ? C.navy : "var(--borde)"),
              background: !buscando && filtro.tipo === "todos" ? C.navyTenue : "#fff",
              color: !buscando && filtro.tipo === "todos" ? C.navy : "var(--texto-suave)",
              fontWeight: !buscando && filtro.tipo === "todos" ? 600 : 400,
            }}>
            Todos
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--texto-tenue)" }}>
            {lista.length} en pantalla{buscando ? " · todos los periodos" : ""}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 1090 }}>
            {/* Cabecera de columnas: sin esto los cinco tildes no se sabe qué
                marcan. Usa la misma plantilla de grid que las filas. */}
            <div style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "6px 16px",
              borderTop: "1px solid var(--borde)", background: C.grisTenue,
              fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
              color: "var(--texto-tenue)", fontWeight: 600,
            }}>
              <span />
              <ColOrden campo="caso" orden={orden} onClick={ordenar}>Caso</ColOrden>
              <ColOrden campo="sla" orden={orden} onClick={ordenar}>SLA 48 h</ColOrden>
              <span>Conductor</span>
              <span>Ruta · centro</span>
              <span style={{ textAlign: "center" }}>Estado</span>
              <span style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>
                {HITOS.map((h) => (
                  <span key={h.clave} title={h.titulo} style={{ textAlign: "center" }}>{h.etiqueta}</span>
                ))}
              </span>
              <ColOrden campo="monto" orden={orden} onClick={ordenar} derecha>Monto</ColOrden>
            </div>

            {cargando ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
                Cargando casos…
              </div>
            ) : lista.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
                {buscando ? `Ningún caso coincide con "${busqueda.trim()}".` : "Nada acá. Probá con otra tarjeta o con otro periodo."}
              </div>
            ) : (
              lista.map((c) => (
                <Fila key={c.case_id} c={c} abierta={abiertas.has(c.case_id)}
                  onAbrir={() => abrirFila(c)}
                  onPedir={pedirDetalle} trayendo={trayendo.has(c.case_id)}
                  ahora={ahora} supervisor={supervisores[c.service_center]}
                  tarea={tareas[c.case_id]} vueltas={vueltas[c.case_id]}
                  onTareaCreada={agregarTarea} onRepedir={repedirPruebas}
                  onNotificar={notificar} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
