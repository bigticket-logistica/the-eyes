import { Fragment, useState, useEffect, useMemo, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import ChatPosventa from "./ChatPosventa.jsx";
import TableroControl from "./TableroControl.jsx";

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

// Casos abiertos que ningún analista ha desplegado. El Topbar lo usa para el
// badge de la pestaña; acá se usa para la marca de la fila. Vive en su propio
// hook para que el Topbar no tenga que montar todo el módulo.
export function usePnrSinVer() {
  const [n, setN] = useState(0);

  useEffect(() => {
    let vivo = true;
    const contar = async () => {
      const { count } = await sb.from("vw_pnr_sin_ver")
        .select("case_id", { count: "exact", head: true });
      if (vivo) setN(count || 0);
    };
    contar();
    const t = setInterval(() => { if (!document.hidden) contar(); }, 60000);
    // Cuando otro analista abre un caso, el badge baja acá también sin esperar
    // el minuto del intervalo.
    const canal = sb.channel("pnr-vistos-badge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "pnr_vistos_mx" }, contar)
      .subscribe();
    return () => { vivo = false; clearInterval(t); sb.removeChannel(canal); };
  }, []);

  return n;
}

const VISTAS = [
  { clave: "pnr",          etiqueta: "PNR",           activa: true  },
  { clave: "devoluciones", etiqueta: "Devoluciones",  activa: false },
  { clave: "chat",         etiqueta: "Chat Posventa", activa: true  },
  { clave: "tablero",      etiqueta: "Tablero de Control", activa: true },
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
  // El grupo lo decide SIEMPRE el sub_estado de MELI.
  //
  // Antes esta función devolvía "rescatable" antes de mirar el sub_estado, y
  // eso sacaba al caso de la lista donde el analista trabaja: la tarjeta de En
  // ruta marcaba 1 y los 21 de Por responder no lo incluían. Dos conjuntos que
  // no se cruzaban, y el caso más recuperable del día escondido en una pestaña
  // aparte. Ahora "En ruta hoy" es un FILTRO sobre la misma lista, no un
  // grupo que se lleva casos.
  const e = POR_ESTADO[c.sub_estado];
  return e ? e.grupo : "responder";
}

// LOS DOS CAMPOS DE RUTA, que ya no significan lo mismo:
//
//   rescatable    → el PNR salió de una ruta del DÍA EN CURSO, haya terminado
//                   esa ruta o no. Es la prioridad máxima de la pantalla y lo
//                   que cuenta la tarjeta "En ruta hoy".
//   ruta_abierta  → además la ruta sigue en calle ahora mismo. Solo alimenta
//                   la insignia: es la señal de que el conductor puede
//                   resolverlo sin volver a salir.
//
// Que la ruta esté cerrada no baja la prioridad. Solo significa que el
// conductor ya entregó todo; sigue siendo el mismo día, todavía puede volver o
// llamar, y sobre todo el cliente todavía se acuerda de quién le entregó.
//
// Con la definición vieja —que exigía ruta abierta— la tarjeta marcaba 1 caso
// el 29 cuando había 10 abiertos de rutas de ese día. Los otros 9 quedaban
// mezclados abajo por SLA, que es justo donde no se los mira.
//
// Al día siguiente el caso sale solo de la prioridad, porque fecha_ruta deja de
// ser hoy a medianoche, y pasa a ordenarse por tiempo restante como el resto.

const GRUPOS = [
  // Rescatable no es un estado de MELI, es una ventana de tiempo: el conductor
  // sigue en calle. Va primera y siempre visible, incluso en cero — el día que
  // marque uno, el analista ya sabe dónde mirar.
  { clave: "rescatable",  etiqueta: "En ruta hoy",    nota: "ruta del día",         color: "#c2410c",  tinte: "#fff1e6",       terminal: false, ventana: true, reloj: true },
  { clave: "responder",   etiqueta: "Por responder",  nota: "falta el comprobante", color: C.naranja,  tinte: C.naranjaTenue,  terminal: false, reloj: true },
  // Con Penalidad va aparte y no dentro de "Por responder" porque la acción es
  // otra: acá no se sube una foto, se pide revisión. Mezclarlos hacía que el
  // analista abriera el caso esperando cargar el comprobante y se encontrara
  // con un botón distinto.
  { clave: "penalidad",   etiqueta: "Con penalidad",  nota: "pedir revisión",       color: "#b8651c",  tinte: "#fdf3e8",       terminal: false, reloj: true },
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
// Cuatro hitos, no seis. Los dos que faltan —"Aviso 2" y "Aviso 3"— eran del
// diseño de escalamientos con umbrales móviles, que se descartó cuando el
// recordatorio pasó a ser uno diario a las 15:00. Sus columnas quedaron vacías y
// el riel mostraba dos círculos que nunca se iban a llenar.
//
// El recordatorio no es un hito que ocurre una vez: son N, uno por día mientras
// el caso siga abierto. Por eso lleva contador en vez de círculo, y la fecha del
// último debajo. Un caso con tres recordatorios y sin comprobante es un
// supervisor que no está respondiendo, y eso el riel ahora lo dice.
const HITOS = [
  { clave: "avisado_inicial_en",   etiqueta: "Aviso",    titulo: "Primer aviso al chofer y al supervisor" },
  { clave: "recordatorio_ultimo",  etiqueta: "Recuerdos", titulo: "Recordatorios diarios enviados",
    contador: "recordatorios" },
  { clave: "pruebas_recibidas_en", etiqueta: "Pruebas",  titulo: "El supervisor cargó las pruebas" },
  { clave: "comprobante_en",       etiqueta: "Cargado",  titulo: "Comprobante cargado en MELI",
    inferir: (c) => ["UPLOADED_RECEIPT", "ON_REVIEW", "ASSIGNED"].includes(c.sub_estado) },
];

// Una sola plantilla de columnas para la cabecera y para las filas: así no
// hay forma de que se desalineen cuando cambie un ancho.
// El ancho de la columna del riel sale de la cantidad de hitos, no de un número
// escrito a mano: cuando el riel pasó de cinco puntos a cuatro, los 286 px
// dejaron los títulos descuadrados respecto de los círculos.
const ANCHO_HITO = 58;
const GRID = `14px 92px 168px minmax(118px,1fr) 122px 126px ${HITOS.length * ANCHO_HITO}px 78px`;

function dinero(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });
}

// Reloj de 24 horas, siempre. Con am/pm un aviso de las 20:02 se pintaba
// "08:02 p" y la "p" quedaba cortada por el ancho de la columna: no había forma
// de distinguirlo de las 8 de la mañana ni mirando de cerca.
//
// En esta pantalla eso no es un detalle de gusto. La columna existe para que el
// analista calcule cuánto plazo queda desde el aviso; leer doce horas de menos
// convierte un caso urgente en uno tranquilo.
//
// La zona es CDMX porque toda la operación —el plazo de 48 h, el recordatorio
// de las 15:00— corre en México, y el analista mira desde Chile.
function fechaHito(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", hour12: false,
    day: "2-digit", month: "2-digit",
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
// LOS TRES SLA DE LA CASCADA, por orden de gerencia:
//
//     0 ───────────────── 40 ──── 48
//        chofer y superv.   Posventa
//
// No son tres relojes paralelos: el plazo se pasa de mano en mano y quien lo
// deja vencer se lo entrega al siguiente. Si nadie resuelve, el monto se cobra
// al tercero.
//
// GERENCIA SUBIÓ EL SLA DEL CHOFER DE 36 A 40
//   Con eso el chofer y el supervisor vencen a la misma hora, así que el primer
//   tramo dejó de ser dos y pasó a ser uno. Se conservan las TRES barras a
//   propósito y no se colapsan en dos: la barra del chofer y la del supervisor
//   marcan lo mismo pero se refieren a personas distintas, y el día que
//   gerencia los vuelva a separar —ya los movió una vez— la pantalla no hay que
//   rehacerla, solo cambiar el número.
//
//   El efecto secundario es que "de quién es el caso" ya no lo decide el reloj
//   entre 0 y 40: los dos lo tienen a la vez. El tramo activo devuelve 'chofer'
//   en esa ventana por convención, y las dos barras se pintan iguales.
//
// Ojo: acá están fijos y en pnr_sla_config también. Si gerencia los mueve hay
// que cambiarlos en los dos lados — el front no lee la config porque leerla
// obligaría a un viaje más en cada carga para tres números que cambian una vez
// al año.
const SLA_H = 48;                      // el de MELI, el que se cuadra con el portal
const SLA_CHOFER = 40;    // era 36 · gerencia lo igualó al del supervisor
const SLA_SUPERVISOR = 40;

// De quién es el caso ahora y cuánto le queda a esa persona.
function tramoActivo(transcurrido) {
  if (transcurrido < SLA_CHOFER) {
    return { quien: "chofer", tope: SLA_CHOFER, restante: SLA_CHOFER - transcurrido };
  }
  if (transcurrido < SLA_SUPERVISOR) {
    return { quien: "supervisor", tope: SLA_SUPERVISOR, restante: SLA_SUPERVISOR - transcurrido };
  }
  if (transcurrido < SLA_H) {
    return { quien: "analista", tope: SLA_H, restante: SLA_H - transcurrido };
  }
  return { quien: "vencido", tope: SLA_H, restante: SLA_H - transcurrido };
}

// Los tres tramos, en orden de la cascada. "Posventa" y no "analista" porque así
// se llama el área: el rótulo tiene que decir lo mismo que dice la gente.
const TRAMOS = [
  { quien: "chofer",     rotulo: "Chofer",     tope: SLA_CHOFER,
    titulo: "El plazo del chofer está corriendo" },
  { quien: "supervisor", rotulo: "Supervisor", tope: SLA_SUPERVISOR,
    // Ya no dice "el plazo del chofer venció": con los dos en 40 h corren
    // juntos, y el texto viejo afirmaba algo falso durante las primeras 40 h.
    titulo: "El plazo del supervisor está corriendo" },
  { quien: "analista",   rotulo: "Posventa",   tope: SLA_H,
    titulo: "Vencieron los plazos del chofer y del supervisor: el caso es de Posventa" },
];

// Reloj y color de un tramo, para no repetir la cuenta en la fila y en el
// detalle. resta en horas decimales; corriendo dice si es el tramo activo.
function pintaTramo(tope, transcurrido, corriendo) {
  const resta = tope - transcurrido;
  const vencido = resta <= 0;
  const pct = Math.max(0, Math.min(100, (transcurrido / tope) * 100));

  // Rojo bajo las 3 h, que es el margen de la alerta final. Los tramos que no
  // corren van en gris tenue: están ahí para que se vea la cadena, no para
  // competir por la atención.
  const color = vencido ? C.gris
    : !corriendo ? "var(--texto-suave)"
    : resta < 3 ? C.ladrillo
    : resta < 8 ? C.naranja
    : C.navy;

  const h = Math.floor(resta);
  const m = Math.floor((resta - h) * 60);

  return {
    resta, vencido, pct, color,
    reloj: vencido ? "vencido" : `${h}:${String(m).padStart(2, "0")}`,
  };
}

function Reloj({ c, ahora }) {
  const g = POR_CLAVE[clasificar(c)];

  // El contador corre solo donde nuestra gestión puede cambiar el resultado.
  // Con el comprobante cargado, en revisión o ya sentenciado, lo que quede de
  // los plazos dejó de importar: los relojes solo competirían por la atención de
  // los casos que sí hay que atender.
  if (!g || !g.reloj) {
    return (
      <span title="No corre: el resultado ya no depende de nosotros"
        style={{ display: "block", lineHeight: 1.25 }}>
        <span style={{ fontSize: 11, color: C.gris }}>sin plazo</span>
        <span style={{ display: "block", fontSize: 9, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
          {c.cuando_mx || "—"}
        </span>
      </span>
    );
  }

  const inicio = c.fecha_caso ? new Date(c.fecha_caso).getTime() : null;
  if (!inicio) return <span style={{ fontSize: 12, color: C.gris }}>—</span>;

  const transcurrido = (ahora - inicio) / 3600000;
  const activo = tramoActivo(transcurrido).quien;

  // LOS TRES PLAZOS EN LA FILA, no solo el activo.
  //
  // Con uno solo el analista no sabe cuándo le cae el caso a él: para eso tiene
  // que ver el reloj del supervisor mientras todavía es del chofer. La fila dice
  // dos cosas distintas — de quién es ahora, y cuánto falta para que sea de los
  // demás — y con un número solo se pierde la segunda.
  return (
    <span style={{ display: "block" }}
      title={`MELI cierra en ${(SLA_H - transcurrido).toFixed(1)} h`}>
      {TRAMOS.map((t) => {
        const corriendo = activo === t.quien;
        const p = pintaTramo(t.tope, transcurrido, corriendo);
        return (
          <span key={t.quien} title={p.vencido
              ? `${t.rotulo}: venció hace ${Math.abs(p.resta).toFixed(1)} h`
              : `${t.titulo}. Quedan ${p.resta.toFixed(1)} h de sus ${t.tope}.`}
            style={{ display: "block", lineHeight: 1.15, marginBottom: 2 }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              {/* 62px y flexShrink 0: "SUPERVISOR" no cabía en 46 y el reloj se
                  le montaba encima. Sin el flexShrink, flex comprime la caja
                  hasta el ancho del contenedor y el texto se desborda en vez de
                  empujar al vecino. */}
              <span style={{ fontSize: 8.5, fontWeight: corriendo ? 700 : 600,
                letterSpacing: 0, textTransform: "uppercase",
                width: 62, flexShrink: 0, whiteSpace: "nowrap",
                color: corriendo ? p.color : "var(--texto-tenue)" }}>
                {t.rotulo}
              </span>
              <span style={{ fontSize: corriendo ? 12 : 10.5,
                fontWeight: corriendo ? 700 : 500, color: p.color,
                fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {p.reloj}
              </span>
              <span style={{ fontSize: 8.5, color: "var(--texto-tenue)", flexShrink: 0 }}>
                /{t.tope}
              </span>
            </span>
            <span style={{ display: "block", height: corriendo ? 3 : 2, borderRadius: 2,
              background: "#e6eaf1" }}>
              <span style={{ display: "block", height: corriendo ? 3 : 2, borderRadius: 2,
                width: `${p.pct}%`, background: p.color }} />
            </span>
          </span>
        );
      })}
      <span style={{ fontSize: 8.5, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
        {c.cuando_mx || "—"}
      </span>
    </span>
  );
}

// ── Los tres plazos, en grande ─────────────────────────────────────────────
// En la fila los tres van chicos y apilados. Acá los mismos tres pero grandes y
// en línea, porque al abrir el caso hay espacio y lo que se está haciendo es
// decidir: vale la pena que el número se lea de lejos.
//
// Comparte TRAMOS y pintaTramo con la fila para que las dos no se puedan
// desincronizar: un umbral cambiado en un solo lado sería un color que dice una
// cosa arriba y otra abajo.

function CascadaSla({ c, ahora }) {
  const inicio = c.fecha_caso ? new Date(c.fecha_caso).getTime() : null;
  if (!inicio) return null;

  const transcurrido = (ahora - inicio) / 3600000;
  const activo = tramoActivo(transcurrido).quien;

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
      {TRAMOS.map((t) => {
        const corriendo = activo === t.quien;
        const p = pintaTramo(t.tope, transcurrido, corriendo);
        return (
          <div key={t.quien}
            title={p.vencido
              ? `${t.rotulo}: venció hace ${Math.abs(p.resta).toFixed(1)} h`
              : `${t.titulo}. Quedan ${p.resta.toFixed(1)} h de sus ${t.tope}.`}
            style={{
              flex: "1 1 120px", minWidth: 110, padding: "6px 10px", borderRadius: 9,
              background: corriendo ? "#eef2f8" : "#fff",
              border: `1px solid ${corriendo ? C.navy : "var(--borde)"}`,
            }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
              textTransform: "uppercase", color: corriendo ? C.navy : "var(--texto-tenue)" }}>
              {t.rotulo} · {t.tope} h{corriendo ? " ←" : ""}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: p.color,
              fontVariantNumeric: "tabular-nums" }}>
              {p.reloj}
            </div>
            <div style={{ height: 3, borderRadius: 2, background: "#e6eaf1", marginTop: 3 }}>
              <div style={{ height: 3, borderRadius: 2, width: `${p.pct}%`, background: p.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Cuánto lleva vivo el caso. Siempre hacia arriba, nunca se detiene.
//
// Formato HH:MM y no HH:MM:SS: en esta pantalla hay veinte filas y veinte
// números saltando cada segundo convierten la lista en algo que parpadea. El
// cronómetro al segundo tiene sentido donde hay una sola tarea y una decisión
// que tomar —la bitácora— no en un listado que se recorre con la vista.
const VIDA_ROJA = 48;   // el plazo de MELI: pasado eso, el caso está vencido

function VidaCaso({ c, ahora }) {
  const inicio = c.fecha_caso ? new Date(c.fecha_caso).getTime() : null;
  if (!inicio) return null;

  // MISMO CRITERIO QUE EL RELOJ DE LA DERECHA: si el resultado ya no depende de
  // nosotros, el contador no corre. Anulado, facturado, en revisión o con el
  // comprobante cargado son casos donde no hay nada que hacer, y un número
  // subiendo ahí solo pide atención para algo que ya se decidió.
  //
  // El grupo lo resuelve POR_CLAVE igual que en Reloj, para que las dos cosas no
  // se puedan desincronizar: si mañana un estado cambia de bando, cambia en un
  // solo lugar.
  const g = POR_CLAVE[clasificar(c)];
  if (!g || !g.reloj) return null;

  const horas = (ahora - inicio) / 3600000;
  const h = Math.floor(horas);
  const m = Math.floor((horas - h) * 60);
  const pasado = horas >= VIDA_ROJA;

  return (
    <span title={pasado
        ? `Lleva ${(horas - VIDA_ROJA).toFixed(1)} h pasado el plazo y sigue esperando comprobante`
        : `Lleva ${h}:${String(m).padStart(2, "0")} desde que Mercado Libre abrió el caso`}
      style={{ display: "block", fontSize: 10, fontWeight: pasado ? 700 : 600,
        color: pasado ? C.ladrillo : "var(--texto-tenue)",
        fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      {h}:{String(m).padStart(2, "0")}
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
    <span style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${HITOS.length}, 1fr)`, gap: 2 }}>
      <span aria-hidden="true" style={{
        position: "absolute", left: "10%", right: "10%", top: 5, height: 0,
        borderTop: terminal ? `2px solid ${color}` : `2px dashed ${color}`,
        opacity: terminal ? 0.55 : 0.28,
      }} />
      {HITOS.map((h) => {
        const f = fechaHito(c[h.clave]);

        // El de recordatorios lleva el número en el punto: no es un hito que
        // ocurre una vez, son varios, y cuántos van importa más que cuándo.
        if (h.contador) {
          const n = Number(c[h.contador] || 0);
          return (
            <span key={h.clave}
              title={n ? `${h.titulo}: ${n}${f ? `, último ${f}` : ""}` : `${h.titulo}: ninguno`}
              style={{ position: "relative", textAlign: "center", lineHeight: 1.15, overflow: "hidden" }}>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                minWidth: 15, height: 15, borderRadius: 8, padding: "0 3px",
                fontSize: 9.5, fontWeight: 700,
                background: n ? color : "transparent",
                border: `1.5px solid ${n ? color : "var(--borde)"}`,
                color: n ? "#fff" : "var(--texto-tenue)",
                boxShadow: `0 0 0 2.5px ${fondo}`, verticalAlign: "middle",
              }}>{n || "–"}</span>
              <div style={{ fontSize: 8, color: "var(--texto-tenue)", whiteSpace: "nowrap", marginTop: 1 }}>
                {f || ""}
              </div>
            </span>
          );
        }

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
// Día en hora de México, formato YYYY-MM-DD. La ventana de 14 horas que había
// antes era imposible de explicar: el analista pregunta "qué se movió hoy", no
// "qué se movió en las últimas catorce horas".
function diaMX(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function hoyMX() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function pct(n, total) {
  if (!total) return "0%";
  return ((Number(n || 0) * 100) / total).toFixed(1) + "%";
}

function Cuadro({ titulo, extra, children }) {
  return (
    <div style={{ flex: 1, minWidth: 320, background: "#fff", border: "1px solid var(--borde)",
      borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
        borderBottom: "1px solid var(--borde)", background: C.grisTenue }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--texto)" }}>{titulo}</span>
        <span style={{ marginLeft: "auto" }}>{extra}</span>
      </div>
      {children}
    </div>
  );
}

// Dos cuadros separados: el de la izquierda es la foto del periodo, el de la
// derecha es lo que se movió en un día. Son preguntas distintas y mezclarlas en
// una sola tabla obligaba a leer seis columnas para contestar cualquiera.
//
// El motivo de cada estado pasó a ser el tooltip del nombre. Es el texto de la
// planilla del analista y vale tenerlo, pero ocupaba media tabla para decir algo
// que ya se sabe de memoria después de la primera semana.
function TablaEstados({ casos, filtro, historial, dia, onDia, onFiltrar, onFiltrarMovidos }) {
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

  // Movimientos del día elegido, contando el destino: la pregunta habitual es
  // "cuántos pasaron A anulado", no cuántos salieron de ahí.
  //
  // Y guardando además de dónde venían, porque el par dice cosas que el total
  // esconde: "Sin comprobante → Anulado" es un caso que se ganó sin subir nada,
  // y "Comprobante cargado → Enviado a facturación" es uno que se perdió
  // habiendo subido la foto. Los dos son señales fuertes.
  const movidos = {};
  const origenes = {};
  let movidosTotal = 0;
  for (const lista of Object.values(historial || {})) {
    for (const m of lista) {
      if (diaMX(m.creado_en) !== dia) continue;
      movidos[m.sub_a] = (movidos[m.sub_a] || 0) + 1;
      if (!origenes[m.sub_a]) origenes[m.sub_a] = {};
      origenes[m.sub_a][m.sub_de] = (origenes[m.sub_a][m.sub_de] || 0) + 1;
      movidosTotal += 1;
    }
  }

  const GRID_A = "1fr 54px 84px 48px";
  const GRID_B = "1fr 64px";

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
      <Cuadro titulo="Estado de los casos">
        <div style={{ display: "grid", gridTemplateColumns: GRID_A, gap: 8, padding: "5px 14px",
          fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
          color: "var(--texto-tenue)", fontWeight: 600 }}>
          <span>Estado</span>
          <span style={{ textAlign: "right" }}>Casos</span>
          <span style={{ textAlign: "right" }}>Monto</span>
          <span style={{ textAlign: "right" }}>%</span>
        </div>
        {ESTADOS_PNR.map((e) => {
          const d = por[e.clave] || { n: 0, monto: 0 };
          const activa = filtro.tipo === "estado" && filtro.valor === e.clave;
          const vacia = d.n === 0;
          return (
            <div key={e.clave} onClick={() => !vacia && onFiltrar(e.clave)} title={e.motivo}
              style={{ display: "grid", gridTemplateColumns: GRID_A, gap: 8, padding: "6px 14px",
                borderTop: "1px solid var(--borde)", cursor: vacia ? "default" : "pointer",
                background: activa ? C.naranjaTenue : "#fff", opacity: vacia ? 0.45 : 1 }}>
              <span style={{ fontSize: 12, fontWeight: activa ? 600 : 500,
                color: COLOR_ESTADO[e.clave] || "var(--texto)", overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.etiqueta}</span>
              <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: "var(--texto)",
                fontVariantNumeric: "tabular-nums" }}>{d.n}</span>
              <span style={{ textAlign: "right", fontSize: 12, color: "var(--texto)",
                fontVariantNumeric: "tabular-nums" }}>{dinero(d.monto)}</span>
              <span style={{ textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
                fontVariantNumeric: "tabular-nums" }}>{pct(d.n, total)}</span>
            </div>
          );
        })}
        <div style={{ display: "grid", gridTemplateColumns: GRID_A, gap: 8, padding: "7px 14px",
          borderTop: `2px solid ${C.navy}`, background: C.navyTenue }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>Total</span>
          <span style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.navy,
            fontVariantNumeric: "tabular-nums" }}>{total}</span>
          <span style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: C.navy,
            fontVariantNumeric: "tabular-nums" }}>{dinero(totalMonto)}</span>
          <span style={{ textAlign: "right", fontSize: 11, color: C.navy }}>100%</span>
        </div>
      </Cuadro>

      <Cuadro titulo="Movimientos del día"
        extra={
          <input type="date" value={dia} max={hoyMX()} onChange={(e) => onDia(e.target.value)}
            style={{ fontSize: 11.5, padding: "2px 6px", borderRadius: 6,
              border: "1px solid var(--borde)" }} />
        }>
        <div style={{ display: "grid", gridTemplateColumns: GRID_B, gap: 8, padding: "5px 14px",
          fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
          color: "var(--texto-tenue)", fontWeight: 600 }}>
          <span>Pasaron a</span>
          <span style={{ textAlign: "right" }}>Casos</span>
        </div>
        {ESTADOS_PNR.map((e) => {
          const n = movidos[e.clave] || 0;
          const activa = filtro.tipo === "movidos_estado" && filtro.valor === e.clave;
          const desde = Object.entries(origenes[e.clave] || {}).sort((a, b) => b[1] - a[1]);
          return (
            <Fragment key={e.clave}>
              <div onClick={() => n && onFiltrarMovidos(e.clave)}
                title={n ? `Ver los ${n} que pasaron a ${e.etiqueta}` : ""}
                style={{ display: "grid", gridTemplateColumns: GRID_B, gap: 8, padding: "6px 14px",
                  borderTop: "1px solid var(--borde)", cursor: n ? "pointer" : "default",
                  background: activa ? C.naranjaTenue : "#fff", opacity: n ? 1 : 0.45 }}>
                <span style={{ fontSize: 12, fontWeight: activa ? 600 : 500,
                  color: COLOR_ESTADO[e.clave] || "var(--texto)", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.etiqueta}</span>
                <span style={{ textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums",
                  fontWeight: n ? 700 : 400, color: n ? C.naranja : "var(--texto-tenue)" }}>
                  {n || "\u2014"}
                </span>
              </div>
              {/* De dónde venían, solo cuando la fila está elegida: el desglose
                  es la pregunta siguiente, no la primera, y mostrarlo siempre
                  alarga el cuadro todos los días para nada. */}
              {activa && desde.map(([sub, cuantos]) => (
                <div key={sub} style={{ display: "grid", gridTemplateColumns: GRID_B, gap: 8,
                  padding: "3px 14px 3px 26px", background: C.naranjaTenue }}>
                  <span style={{ fontSize: 11, color: "var(--texto-suave)", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    desde {(POR_ESTADO[sub] || {}).etiqueta || sub}
                  </span>
                  <span style={{ textAlign: "right", fontSize: 11, color: "var(--texto-suave)",
                    fontVariantNumeric: "tabular-nums" }}>{cuantos}</span>
                </div>
              ))}
            </Fragment>
          );
        })}
        <div style={{ display: "grid", gridTemplateColumns: GRID_B, gap: 8, padding: "7px 14px",
          borderTop: `2px solid ${C.navy}`, background: C.navyTenue }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>Total</span>
          <span style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.navy,
            fontVariantNumeric: "tabular-nums" }}>{movidosTotal || "\u2014"}</span>
        </div>
      </Cuadro>
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

// ═══════════════════════════════════════════════════════════════════════════
// TELÉFONOS DEL CONDUCTOR
//
// Muestra todos los números conocidos con su procedencia, y deja al analista
// agregar uno nuevo cuando el supervisor se lo pasa.
//
// POR QUÉ EL ANALISTA TIENE QUE PODER ESCRIBIRLO
//   De 78 casos abiertos, 17 tienen teléfono de MELI y 30 cruzan con el
//   directorio de la torre. El resto no tiene a quién avisarle. Y los cruces
//   automáticos no sirven: el nombre que guarda la torre son apodos —"arturo",
//   "Raúl M"— y un conductor cambia de placa entre rutas, así que los dos daban
//   números de otra persona con aire de certeza.
//
//   La única fuente confiable es preguntarle al supervisor. Cuesta una llamada
//   la primera vez y después ese conductor ya tiene número: se guarda por
//   conductor, no por caso, y un conductor puede tener tres PNR abiertos a la
//   vez.
// ═══════════════════════════════════════════════════════════════════════════

const FUENTES = {
  posventa:   { etiqueta: "propio",     color: "#1f7a5c" },
  directorio: { etiqueta: "directorio", color: "#1a3a6b" },
  meli:       { etiqueta: "MELI",       color: "#8a94a6" },
};

function Telefonos({ c, telefonos, elegido, onElegir, onGuardado }) {
  const [abierto, setAbierto] = useState(false);
  const [numero, setNumero] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const nombre = (c.transportista || c.conductor_ruta || c.conductor || "").trim();
  const lista = (telefonos || []).slice()
    .sort((a, b) => (b.confianza || 0) - (a.confianza || 0));

  async function guardar() {
    const limpio = numero.replace(/\D/g, "");
    if (limpio.length < 10) { setError("Faltan dígitos. Con código de país."); return; }
    if (!nombre) { setError("El caso no tiene nombre de conductor."); return; }
    setGuardando(true);
    setError("");
    try {
      const { error: e } = await sb.rpc("fn_pnr_guardar_telefono", {
        p_conductor: nombre,
        p_telefono: numero,
        p_origen: "supervisor",
        p_nota: nota.trim() || null,
        p_quien: "analista",
      });
      if (e) throw new Error(e.message);
      setNumero(""); setNota(""); setAbierto(false);
      if (onGuardado) await onGuardado();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 10, padding: "8px 10px",
      background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase",
          letterSpacing: 0.3 }}>🚚 Conductor</span>
        <button onClick={() => setAbierto((v) => !v)}
          title="Agregar un número que te pasó el supervisor"
          style={{ marginLeft: "auto", fontSize: 10.5, padding: "1px 7px", borderRadius: 6,
            border: "1px solid var(--borde)", background: "#fff",
            color: "var(--texto-suave)", cursor: "pointer" }}>
          {abierto ? "Cancelar" : "+ número"}
        </button>
      </div>

      <div style={{ fontSize: 12.5, color: "var(--texto)", lineHeight: 1.3 }}>
        {nombre || "—"}
      </div>

      {lista.length === 0 ? (
        <div style={{ fontSize: 12, color: C.ladrillo, marginTop: 2 }}>
          Sin teléfono. Pídeselo al supervisor y guárdalo acá.
        </div>
      ) : (
        <div style={{ marginTop: 3 }}>
          {lista.map((t) => {
            const f = FUENTES[t.fuente] || { etiqueta: t.fuente, color: C.gris };
            const activo = elegido ? elegido === t.telefono : t === lista[0];
            return (
              <div key={`${t.fuente}-${t.telefono}`}
                onClick={() => onElegir && onElegir(t.telefono)}
                title={activo ? "Este es el que se va a usar" : "Usar este número"}
                style={{ display: "flex", alignItems: "baseline", gap: 6,
                  cursor: onElegir ? "pointer" : "default", padding: "1px 0" }}>
                {/* El punto marca cuál se va a usar. Con un solo número no hay
                    nada que elegir, pero igual se ve cuál es. */}
                <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: activo ? C.naranja : "transparent",
                  border: `1px solid ${activo ? C.naranja : "var(--borde)"}` }} />
                <span style={{ fontSize: 14, fontWeight: activo ? 700 : 500,
                  color: activo ? C.navy : "var(--texto-suave)",
                  fontVariantNumeric: "tabular-nums" }}>
                  {t.telefono}
                </span>
                <span style={{ fontSize: 9.5, fontWeight: 600, color: f.color,
                  border: `1px solid ${f.color}`, borderRadius: 4, padding: "0 4px" }}>
                  {f.etiqueta}
                </span>
                {/* Confirmado por uso: el conductor escribió desde ese número.
                    Es la única prueba dura de que funciona. */}
                {t.confianza === 4 && (
                  <span title="El conductor escribió desde este número"
                    style={{ fontSize: 10, color: C.verde }}>✓ contestó</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {abierto && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--borde)" }}>
          <input value={numero} onChange={(e) => setNumero(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") guardar(); }}
            placeholder="+52 1 55 1234 5678"
            style={{ width: "100%", fontSize: 12.5, padding: "5px 8px", borderRadius: 7,
              border: "1px solid var(--borde)", boxSizing: "border-box", marginBottom: 4 }} />
          <input value={nota} onChange={(e) => setNota(e.target.value)}
            placeholder="Quién lo pasó (opcional)"
            style={{ width: "100%", fontSize: 11, padding: "4px 8px", borderRadius: 7,
              border: "1px solid var(--borde)", boxSizing: "border-box", marginBottom: 5 }} />
          <button onClick={guardar} disabled={guardando}
            style={{ width: "100%", fontSize: 11.5, fontWeight: 600, padding: "5px 10px",
              borderRadius: 7, cursor: "pointer", border: `1px solid ${C.naranja}`,
              background: C.naranja, color: "#fff" }}>
            {guardando ? "Guardando…" : "Guardar para este conductor"}
          </button>
          <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", marginTop: 4, lineHeight: 1.35 }}>
            Se guarda a nombre de <strong>{nombre || "—"}</strong>, así que sirve
            para todos sus reclamos, no solo este.
          </div>
          {error && (
            <div style={{ fontSize: 11, color: C.ladrillo, marginTop: 4 }}>{error}</div>
          )}
        </div>
      )}

      {[c.patente, c.transportadora].filter(Boolean).length > 0 && (
        <div style={{ fontSize: 11, color: "var(--texto-suave)", lineHeight: 1.35, marginTop: 3 }}>
          {[c.patente, c.transportadora].filter(Boolean).join(" · ")}
        </div>
      )}
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

function Pruebas({ tarea, vueltas, onRepedir, onAprobar }) {
  // Una vez aprobada no se vuelve a ofrecer la decisión: la tarea pasó a otra
  // fase y lo que falta —cargar el comprobante— no lo hace el analista.
  const yaAprobada = !!tarea?.aprobada_en;
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
          {/* La foto a la izquierda y lo que se dice de ella a la derecha.
              Antes la nota de Vision vivía en el title de la insignia: para
              leerla había que adivinar que estaba ahí y dejar el cursor quieto.
              Es el texto que dice QUÉ FALTA en la evidencia — lo único que el
              analista necesita para decidir si rechaza y con qué motivo. */}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Miniaturas fotos={v.fotos} />
            {(v.vision_nota || v.vision_veredicto) && (
              <div style={{ flex: "1 1 240px", minWidth: 200, fontSize: 11.5, lineHeight: 1.45,
                background: "#fff", border: "1px solid var(--borde)", borderRadius: 8,
                padding: "7px 10px" }}>
                {v.vision_veredicto && (
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                    textTransform: "uppercase", marginBottom: 3,
                    color: v.vision_veredicto === "SIRVE" ? C.verde
                      : v.vision_veredicto === "PARCIAL" ? C.naranja : C.ladrillo }}>
                    {v.vision_veredicto.replace("_", " ")}
                    {v.vision_tipo ? ` · ${String(v.vision_tipo).toLowerCase()}` : ""}
                  </div>
                )}
                <div style={{ color: "var(--texto-suave)" }}>{v.vision_nota}</div>
                {/* Que es una recomendación y no un dictamen. La decisión de
                    rechazar la toma el analista, y el criterio lo dice: un
                    puntaje alto sobre una captura recortada puede seguir sin
                    servir para apelar. */}
                <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", marginTop: 4 }}>
                  Lectura automática · la decisión es tuya
                </div>
              </div>
            )}
          </div>
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
          /* ── APROBADO Y RECHAZADO ──────────────────────────────────────
             Los dos juntos y con el mismo peso visual: son las dos salidas de
             la misma decisión y el analista elige una. Antes solo estaba el
             rechazo, así que aprobar era no hacer nada — y no hacer nada no
             manda el WhatsApp que le dice al supervisor que ahora le toca
             cargar el comprobante en Logistic.

             Aprobado pide confirmación porque no se puede deshacer desde acá y
             además dispara un mensaje. Rechazado ya la tenía: exige el motivo. */
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap",
            alignItems: "center" }}>
            {yaAprobada ? (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: C.verde }}>
                ✓ Pruebas aprobadas · el supervisor debe cargar el comprobante en Logistic
              </span>
            ) : (
              <>
                <button
                  onClick={() => {
                    if (window.confirm(
                      "¿Aprobar estas pruebas?\n\n" +
                      "Se le avisa al supervisor que ahora debe cargar el comprobante " +
                      "en Logistic. No se puede deshacer desde acá.")) {
                      onAprobar(tarea);
                    }
                  }}
                  disabled={!hayAlgo}
                  title={hayAlgo ? "" : "No hay pruebas que aprobar"}
                  style={{ fontSize: 12, fontWeight: 600, padding: "6px 13px", borderRadius: 8,
                    cursor: hayAlgo ? "pointer" : "default",
                    border: `2px solid ${hayAlgo ? C.verde : "var(--borde)"}`,
                    background: hayAlgo ? "#eaf5f1" : "#fff",
                    color: hayAlgo ? C.verde : "var(--texto-tenue)" }}>
                  Aprobado
                </button>
                <button onClick={() => setPidiendo(true)}
                  style={{ fontSize: 12, fontWeight: 600, padding: "6px 13px", borderRadius: 8,
                    border: `2px solid ${C.ladrillo}`, background: "#fff",
                    color: C.ladrillo, cursor: "pointer" }}>
                  Rechazado
                </button>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

// La línea de tiempo del caso: cada cambio de estado con su hora, del más
// nuevo al más viejo. Es el equivalente al panel de Actividad de MELI, pero con
// los nombres del analista y sin salir de la pantalla.
//
// Importa porque un cambio de estado tiene consecuencias: si un caso pasó a
// Anulado, hay que dejar de perseguir la foto; si pasó a Facturación, ya no se
// puede hacer nada. Sin esto, un caso anulado hace diez minutos se ve igual que
// uno anulado hace tres días.
// "hace 2 h" para el chip de la fila. Marca si fue hoy, que es lo que decide
// si el analista tiene que mirarlo ahora.
function hace(iso, ahora) {
  if (!iso) return { texto: "", hoy: false };
  const min = Math.round((ahora - new Date(iso).getTime()) / 60000);
  const hoy = diaMX(iso) === hoyMX();
  if (min < 60) return { texto: `hace ${Math.max(min, 1)} min`, hoy };
  if (min < 2880) return { texto: `hace ${Math.round(min / 60)} h`, hoy };
  return { texto: `hace ${Math.round(min / 1440)} d`, hoy };
}

function nombreEstado(sub) {
  const e = POR_ESTADO[sub];
  return e ? e.etiqueta : sub || "—";
}

function LineaTiempo({ movimientos }) {
  const ms = (movimientos || []).slice().sort(
    (a, b) => new Date(b.creado_en) - new Date(a.creado_en)
  );
  if (!ms.length) return null;

  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 10, background: "#fff",
      padding: "9px 11px", marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)", marginBottom: 6 }}>
        Movimientos en MELI
      </div>
      {ms.map((m) => {
        const color = COLOR_ESTADO[m.sub_a] || C.gris;
        return (
          <div key={m.id} style={{ display: "flex", alignItems: "baseline", gap: 8,
            padding: "2.5px 0", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, color: "var(--texto-tenue)", minWidth: 92,
              fontVariantNumeric: "tabular-nums" }}>
              {fechaHito(m.creado_en)}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--texto-tenue)" }}>
              {nombreEstado(m.sub_de)}
            </span>
            <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>→</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color }}>
              {nombreEstado(m.sub_a)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Detalle({ c, ahora, onPedir, trayendo, supervisor, tarea, vueltas, movimientos, telefonos, telElegido, onElegirTel, onTelGuardado, onTareaCreada, onRepedir, onAprobar, onNotificar }) {
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
    const r = onNotificar
      ? await onNotificar(c.case_id, "inicial", cuerpoAviso(), telElegido)
      : { ok: false, error: "sin envío" };
    setEnvio(r);
    setCreando(false);
  }

  // Repetir el aviso inicial cuando la tarea ya existe.
  async function soloNotificar() {
    setCreando(true);
    setEnvio(null);
    const r = onNotificar
      ? await onNotificar(c.case_id, "inicial", cuerpoAviso(), telElegido)
      : { ok: false, error: "sin envío" };
    setEnvio(r);
    setCreando(false);
  }

  // Recordatorio a demanda, solo WhatsApp. El automático sale a las 15:00; este
  // es para cuando el analista ve que a un caso le quedan pocas horas y no
  // quiere esperar al horario.
  async function recordar() {
    setCreando(true);
    setEnvio(null);
    const r = onNotificar
      ? await onNotificar(c.case_id, "recordatorio", null, telElegido)
      : { ok: false, error: "sin envío" };
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
      telefono_conductor: telElegido || c.telefono || c.telefono_ruta,
      supervisor_nombre: supervisor ? supervisor.supervisor_nombre : null,
      // Sin reemplazos de prueba en el código: los datos de prueba viven en
      // supervisores_bt, que es una sola fila y se revierte con un update. Dos
      // constantes acá y un update en la base son dos verdades sobre lo mismo,
      // y la del código gana en silencio.
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
      {/* Respondido a MELI sin comprobante. Es el estado donde más plata se
          pierde y el que menos se nota: el caso sigue abierto, el reloj corre,
          y ya se le dijo a Mercado Libre que no hay evidencia. Va arriba del
          detalle para que el analista no lo trate como uno más. */}
      {c.sub_estado === "WITHOUT_RECEIPT" && (
        <div style={{ fontSize: 12.5, color: "#fff", background: C.ladrillo,
          borderRadius: 10, padding: "8px 12px", marginBottom: 8, lineHeight: 1.4 }}>
          <strong>Se respondió a Mercado Libre sin comprobante.</strong>{" "}
          El caso queda sin respaldo y va camino al cobro. Si el supervisor
          consigue la evidencia, todavía se puede pelear.
        </div>
      )}

      {/* Se quitó el aviso "Entregado hoy · el conductor ya terminó la ruta".
          Afirmaba algo falso: lo decidía por ruta_abierta, que no existe en
          vw_pnr_detalle, así que siempre caía del lado de "terminó" — incluso en
          rutas con estado active y cuarenta y siete paradas pendientes.

          Y aunque el dato estuviera, el aviso no aportaba: que el PNR es de una
          ruta de hoy ya se ve en la insignia EN RUTA de la fila, antes de
          desplegar, que es donde el analista lo necesita. Un cartel adentro
          repite lo que ya sabe y afirma detalles de la ruta que esta pantalla no
          tiene con qué sostener. */}

      {/* ── La cascada completa ──────────────────────────────────────────
          En la fila va un solo reloj, el del tramo activo. Acá los tres, porque
          al abrir el caso lo que se necesita es otra cosa: saber cuándo le cae
          a uno. Un analista que ve "supervisor 2:14" sabe que en dos horas el
          caso es suyo y puede adelantarse en vez de enterarse cuando ya venció.

          El plazo de MELI va último y en gris: es el que se cuadra con el
          portal, no el que hay que perseguir. */}
      <CascadaSla c={c} ahora={ahora} />

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

          <Pruebas tarea={tarea} vueltas={vueltas} onRepedir={onRepedir} onAprobar={onAprobar} />

          <LineaTiempo movimientos={movimientos} />
        </div>

        {/* Derecha: a quién llamar y el botón que lo dispara */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Telefonos c={c} telefonos={telefonos} elegido={telElegido}
            onElegir={onElegirTel} onGuardado={onTelGuardado} />

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
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={soloNotificar} disabled={creando}
                      title="Vuelve a mandar el aviso inicial y el correo"
                      style={{ flex: 1, fontSize: 11.5, padding: "6px 10px", borderRadius: 8,
                        cursor: "pointer", border: "1px solid var(--borde)",
                        background: "#fff", color: "var(--texto-suave)" }}>
                      {creando ? "…" : "Repetir el inicial"}
                    </button>
                    {/* Recordatorio a demanda, solo WhatsApp. El automático sale
                        a las 15:00; el botón lleva las horas que le quedan al
                        caso para que el analista decida si vale adelantarlo. */}
                    <button onClick={recordar} disabled={creando}
                      title="Manda solo el WhatsApp de recordatorio, sin correo"
                      style={{ flex: 1, fontSize: 11.5, padding: "6px 10px", borderRadius: 8,
                        cursor: "pointer", border: `1px solid ${C.naranja}`,
                        background: C.naranjaTenue, color: C.naranja, fontWeight: 600 }}>
                      {creando ? "…" : `Recordar · ${c.horas_restantes != null ? Math.round(c.horas_restantes) + " h" : "—"}`}
                    </button>
                  </div>
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
                    Se crea la tarea en la bitácora y salen tres avisos: WhatsApp al chofer,
                    WhatsApp al supervisor y correo al supervisor. Los recordatorios
                    posteriores son solo WhatsApp.
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
                      <div style={{ fontWeight: 600 }}>
                        {envio.tipo === "recordatorio" ? "Recordatorio encolado" : "Avisos encolados"}
                        {envio.horas_restantes != null ? ` · quedan ${envio.horas_restantes} h` : ""}
                      </div>
                      {/* Un renglón por destino, con el número que se usó de
                          verdad. Es la primera pregunta cuando el conductor no
                          responde, y sin esto habría que ir a mirar la tabla de
                          mensajes para contestarla. */}
                      <div style={{ color: envio.conductor?.ok ? "var(--texto-suave)" : C.ladrillo }}>
                        Chofer: {envio.conductor?.ok
                          ? envio.conductor.telefono
                          : `no salió — ${envio.conductor?.error || "sin teléfono"}`}
                      </div>
                      <div style={{ color: envio.supervisor?.ok ? "var(--texto-suave)" : C.ladrillo }}>
                        Supervisor: {envio.supervisor?.ok
                          ? `${envio.supervisor.nombre || ""} ${envio.supervisor.telefono || ""}`.trim()
                          : `no salió — ${envio.supervisor?.error || "sin teléfono"}`}
                      </div>
                      {envio.correo !== undefined && (
                        <div style={{ color: envio.correo ? "var(--texto-suave)" : C.ladrillo }}>
                          Correo: {envio.correo ? "enviado" : `no salió — ${envio.correo_error || "sin detalle"}`}
                        </div>
                      )}
                      {envio.marcado === false && (
                        <div style={{ color: C.ladrillo, marginTop: 3 }}>
                          No se pudo marcar el hito Aviso 1: {envio.error_marca}
                        </div>
                      )}
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

function Fila({ c, abierta, onAbrir, onPedir, trayendo, ahora, supervisor, tarea, vueltas, movimientos, sinVer, fueraDePeriodo, telefonos, telElegido, onElegirTel, onTelGuardado, onTareaCreada, onRepedir, onAprobar, onNotificar }) {
  const g = POR_CLAVE[clasificar(c)];
  const fondo = abierta ? C.grisTenue : "#fff";
  const sub = chipEstado(c.sub_estado);
  const ultimoMov = (movimientos || []).reduce(
    (mx, m) => (!mx || new Date(m.creado_en) > new Date(mx) ? m.creado_en : mx), null
  );
  return (
    <Fragment>
      <div onClick={onAbrir} style={{
        display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 10,
        padding: "8px 16px", borderTop: "1px solid var(--borde)", cursor: "pointer",
        background: abierta ? C.grisTenue : "#fff",
      }}>
        <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}>{abierta ? "▾" : "▸"}</span>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)", fontVariantNumeric: "tabular-nums" }}>
          {/* ── La edad del caso, arriba del número ──────────────────────
              Cuenta HACIA ARRIBA desde que Mercado Libre lo abrió, y no se
              detiene nunca: pasadas las 48 h sigue subiendo.

              Los tres relojes de la derecha cuentan hacia abajo y se quedan en
              "vencido" — correcto, porque un plazo agotado no tiene resto. Pero
              entonces la fila deja de decir CUÁNTO lleva el caso, y un caso de
              hace dos días se ve igual que uno de hace una semana. Este número
              es el único que sigue moviéndose.

              Rojo pasadas las 48 h, cuando ya se venció el plazo de MELI. */}
          <VidaCaso c={c} ahora={ahora} />
          {c.case_id}
          {/* De otro periodo, pero sigue esperando comprobante. Aparece igual
              porque todavía se puede pelear; la etiqueta explica por qué está
              acá cuando el selector dice otra quincena. */}
          {fueraDePeriodo && (
            <span title={`Es del periodo ${c.periodo} y sigue esperando comprobante`}
              style={{ display: "block", fontSize: 8.5, color: C.naranja, whiteSpace: "nowrap" }}>
              {c.periodo}
            </span>
          )}
        </span>
        <Reloj c={c} ahora={ahora} />
        <span style={{ minWidth: 0, fontSize: 13, color: "var(--texto)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {/* Lee rescatable, que es "PNR de una ruta del día".
              La versión anterior leía ruta_abierta y NUNCA se dibujaba: esa
              columna existe en vw_pnr_tablero pero no en vw_pnr_detalle, que es
              de donde lee esta pantalla. Un campo ausente en JavaScript es
              undefined, o sea falso, así que la insignia desaparecía sin dar
              error. Es el peor tipo de fallo: nada se rompe, solo falta. */}
          {c.rescatable && (
            <span title="PNR de una ruta de hoy: el conductor todavía puede resolverlo"
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
        <span style={{ textAlign: "center", lineHeight: 1.2, overflow: "hidden" }}>
          <span style={{
            display: "inline-block", fontSize: 10.5, fontWeight: 600, color: sub.color,
            border: `1px solid ${sub.color}`, borderRadius: 20, padding: "1px 7px",
            whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
          }}>{sub.corto}</span>
          {/* Cuánto hace que MELI lo movió. Sin esto, un caso anulado hace diez
              minutos se ve igual que uno anulado hace tres días, y el analista
              no sabe cuál dejar de perseguir. */}
          {ultimoMov && (
            <span style={{ display: "block", fontSize: 8.5, whiteSpace: "nowrap",
              color: hace(ultimoMov, ahora).hoy ? C.naranja : "var(--texto-tenue)" }}>
              {hace(ultimoMov, ahora).texto}
            </span>
          )}
        </span>
        <Riel c={c} color={COLOR_ESTADO[c.sub_estado] || g.color} terminal={g.terminal} fondo={fondo} />
        <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
          {dinero(c.monto)}
        </span>
      </div>
      {abierta && <Detalle c={c} ahora={ahora} onPedir={onPedir} trayendo={trayendo} supervisor={supervisor}
        tarea={tarea} vueltas={vueltas} movimientos={movimientos}
        telefonos={telefonos} telElegido={telElegido} onElegirTel={onElegirTel}
        onTelGuardado={onTelGuardado}
        onTareaCreada={onTareaCreada} onRepedir={onRepedir} onAprobar={onAprobar} onNotificar={onNotificar} />}
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
  const [historial, setHistorial] = useState({});
  const [diaMov, setDiaMov] = useState(() => hoyMX());
  const [vistos, setVistos] = useState(() => new Set());
  const [telefonos, setTelefonos] = useState({});
  // El número que el analista eligió para cada caso. Se guarda en el navegador
  // y no en la base porque es una preferencia de la sesión de trabajo: si otro
  // analista abre el mismo caso, la elección la hace él.
  const [telElegidos, setTelElegidos] = useState({});
  // Mensajes de conductores sin leer, para el globo de la pestaña Chat
  // Posventa. Va acá y no dentro del módulo del chat porque la pestaña se
  // dibuja antes de que el chat monte: si el contador viviera allá, el número
  // aparecería recién al entrar, justo cuando ya no sirve para avisar.
  const [msjSinLeer, setMsjSinLeer] = useState(0);

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
        .select("id, case_id, sc, estado, supervisor_nombre, creada_en, fotos, comentario, veces_pedida, motivo_reabrir, aprobada_en, aprobada_por")
        .in("estado", ["pendiente", "vista", "completada", "sin_pruebas"])
        .limit(5000),
      sb.from("pnr_tareas_vueltas").select("*").order("vuelta").limit(5000),
    ]);

    await cargarTelefonos();

    const vis = await sb.from("pnr_vistos_mx").select("case_id").limit(10000);
    if (!vis.error && vis.data) setVistos(new Set(vis.data.map((x) => x.case_id)));

    // Últimos treinta días de movimientos, para que el selector de fecha sirva
    // de algo. Son unos 25 cambios diarios, así que el volumen es trivial.
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const hist = await sb.from("pnr_historial_mx")
      .select("*").gte("creado_en", desde).order("creado_en", { ascending: false }).limit(3000);
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
    if (!hist.error && hist.data) {
      const m = {};
      for (const f of hist.data) {
        if (!m[f.case_id]) m[f.case_id] = [];
        m[f.case_id].push(f);
      }
      setHistorial(m);
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
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "pnr_historial_mx" },
        async (payload) => {
          const h = payload.new;
          if (!h || !h.case_id) return;
          setHistorial((prev) => ({
            ...prev,
            [h.case_id]: [h, ...(prev[h.case_id] || [])],
          }));
          // El cambio de estado viene del scraper, así que hay que releer la
          // fila: el chip, el grupo y la tarjeta donde vive el caso cambian
          // todos a la vez.
          const { data } = await sb.from("vw_pnr_detalle")
            .select("*").eq("case_id", h.case_id).maybeSingle();
          if (data) {
            setCasos((prev) => prev.map((x) => x.case_id === data.case_id ? { ...x, ...data } : x));
          }
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
    let vivo = true;
    const contarMsj = async () => {
      const { data } = await sb.from("pnr_conversaciones_mx")
        .select("no_leidos").gt("no_leidos", 0);
      if (vivo) setMsjSinLeer((data || []).reduce((s, c) => s + (c.no_leidos || 0), 0));
    };
    contarMsj();
    const t = setInterval(() => { if (!document.hidden) contarMsj(); }, 30000);
    const canal = sb.channel("pnr-chat-badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_conversaciones_mx" }, contarMsj)
      .subscribe();
    return () => { vivo = false; clearInterval(t); sb.removeChannel(canal); };
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

  // El periodo puro. Alimenta la tabla de estados, que existe para cuadrar el
  // total contra el panel de MELI: si le metiéramos casos de otra quincena, el
  // número dejaría de coincidir y la tabla perdería su razón de ser.
  const delPeriodo = useMemo(
    () => casos.filter((c) => !periodo || c.periodo === periodo),
    [casos, periodo]
  );

  // La lista, en cambio, SIEMPRE incluye los que esperan comprobante, aunque
  // sean de otro periodo.
  //
  // Un caso que nace el 30 de agosto tiene plazo hasta el 1 de septiembre. Con
  // el filtro puro, el 1 de septiembre el selector salta a la quincena nueva y
  // ese caso desaparece de la pantalla con horas de plazo por delante. El
  // analista no trabaja sobre una quincena contable: trabaja sobre lo que
  // todavía se puede pelear.
  const paraLista = useMemo(() => {
    if (!periodo) return casos;
    const dentro = new Set(delPeriodo.map((c) => c.case_id));
    const rezagados = casos.filter(
      (c) => !dentro.has(c.case_id) && !c.cerrado && c.sub_estado === "WAITING_RECEIPT"
    );
    return [...delPeriodo, ...rezagados];
  }, [casos, delPeriodo, periodo]);

  const totales = useMemo(() => {
    const t = {};
    for (const g of GRUPOS) t[g.clave] = { monto: 0, n: 0 };
    for (const c of delPeriodo) {
      const k = clasificar(c);
      t[k].monto += Number(c.monto || 0);
      t[k].n += 1;
      // El rescatable se suma ADEMÁS en su tarjeta. Un caso en ruta cuenta dos
      // veces —en En ruta y en el grupo de su estado— y eso es a propósito: la
      // tarjeta dejó de ser un grupo excluyente y pasó a ser un atajo. El total
      // de las tarjetas ya no es el total de casos.
      if (c.rescatable) {
        t.rescatable.monto += Number(c.monto || 0);
        t.rescatable.n += 1;
      }
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
      : paraLista.filter((c) => {
          if (filtro.tipo === "todos") return true;
          if (filtro.tipo === "movidos_estado") {
            return (historial[c.case_id] || []).some(
              (m) => m.sub_a === filtro.valor && diaMX(m.creado_en) === diaMov
            );
          }
          if (filtro.tipo === "movidos") {
            return (historial[c.case_id] || []).some((m) => diaMX(m.creado_en) === diaMov);
          }
          if (filtro.tipo === "estado") return c.sub_estado === filtro.valor;
          // En ruta ya no es un grupo: es una marca sobre el caso, así que se
          // pregunta por la marca y no por la clasificación.
          if (filtro.valor === "rescatable") return !!c.rescatable;
          return clasificar(c) === filtro.valor;
        });

    // Orden simple y predecible: por defecto el más viejo arriba, que es el
    // que más cerca está de perderse. La versión anterior mandaba los vencidos
    // al fondo razonando que el SLA ya no los distingue, y con eso escondía un
    // caso de $1.655 con 145 horas debajo de uno de $69 con media hora. Un
    // caso vencido sigue abierto en MELI y sigue siendo plata que se puede
    // pelear; que el reloj se haya pasado no lo vuelve menos urgente.
    // Cuando el grupo no lleva reloj, ordenar por horas restantes ordena por un
    // número que no se ve en pantalla. Ahí manda el monto, que es lo único que
    // distingue un caso de otro cuando ya no hay plazo.
    const conReloj = (POR_CLAVE[filtro.tipo === "grupo" ? filtro.valor : ""] || {}).reloj;
    const porMonto = orden.campo === "sla" && filtro.tipo === "grupo" && !conReloj;

    const valor = (c) => {
      if (orden.campo === "monto" || porMonto) return -Number(c.monto || 0);
      if (orden.campo === "caso") return Number(c.case_id || 0);
      return c.horas_restantes == null ? 9999 : Number(c.horas_restantes);
    };
    // TODO PNR de una ruta del día en curso va arriba, por encima del orden que
    // elija el analista y sin importar si esa ruta ya terminó. Es cuando la
    // evidencia todavía se consigue con un mensaje: el cliente recibió el
    // paquete hace horas y se acuerda de quién se lo dio.
    //
    // Dentro de ese grupo manda la columna elegida, no la ruta abierta. Entre
    // dos casos del mismo día lo que decide es cuánto plazo queda; que el
    // camión siga en calle es una facilidad, no una urgencia mayor.
    //
    // Esto no depende del filtro: en la pantalla inicial, sin ninguna tarjeta
    // apretada, los del día salen arriba igual.
    return base.slice().sort((a, b) => {
      if (!!a.rescatable !== !!b.rescatable) return a.rescatable ? -1 : 1;
      const d = valor(a) - valor(b);
      return orden.dir === "asc" ? d : -d;
    });
  }, [casos, delPeriodo, paraLista, filtro, busqueda, buscando, orden, historial, diaMov]);

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

      // La ficha de teléfonos lee vw_pnr_telefonos, que se carga una sola vez al
      // abrir la pantalla. El teléfono del chofer llega recién ahora, con el
      // detalle: sin este refresco la ficha diría "sin teléfono" para un caso
      // que acaba de traer uno, y el analista lo iría a pedir al supervisor sin
      // necesidad.
      cargarTelefonos();
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
  // Dispara los avisos.
  //
  //   WhatsApp al chofer y al supervisor  -> cola del canal de Posventa
  //   Correo al supervisor                -> flujo de n8n, solo en el inicial
  //
  // Los WhatsApp van por la cola y no por n8n para que el mensaje quede en el
  // hilo del chat: así el analista ve qué se le dijo al conductor y puede
  // seguir la conversación desde ahí. Con un envío por fuera sería invisible.
  //
  // Y los parámetros de la plantilla los arma fn_pnr_avisar en la base, no el
  // navegador: el recordatorio de las 15:00 y el aviso de cambio de estado
  // llaman a la misma función, y si cada uno los armara por su lado
  // terminarían mandando textos distintos.
  async function notificar(caseId, tipo, datosCorreo, telefono) {
    const t = tipo || "inicial";
    let wa = { ok: false, error: "sin envío" };

    try {
      // El teléfono elegido va solo si el analista eligió uno. Si no, la
      // función decide: primero el último con el que se le escribió a este
      // caso, después el de MELI. Así el automático de las 15:00 sigue la
      // decisión del analista sin guardarla en ninguna columna.
      const { data, error } = await sb.rpc("fn_pnr_avisar", {
        p_case_id: caseId, p_tipo: t, p_quien: "analista",
        p_telefono: telefono || null,
      });
      if (error) throw new Error(error.message);
      const r = data || {};
      // Los dos destinos se encolan en bloques separados en la base, así que
      // uno puede salir y el otro no. Se devuelve el detalle de cada uno.
      wa = { ok: !!(r.conductor?.ok || r.supervisor?.ok), ...r };
    } catch (e) {
      wa = { ok: false, error: String(e.message || e) };
    }

    // El correo va solo con el aviso inicial: los recordatorios y los cambios
    // de estado son WhatsApp nada más. Y va aparte de los WhatsApp: si n8n
    // está caído, el conductor igual se enteró.
    if (t === "inicial" && WEBHOOK_NOTIFICAR && datosCorreo) {
      try {
        const r = await fetch(WEBHOOK_NOTIFICAR, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(WEBHOOK_SECRETO ? { "x-pnr-secret": WEBHOOK_SECRETO } : {}),
          },
          body: JSON.stringify({ ...datosCorreo, solo_correo: true }),
        });
        wa.correo = r.ok;
        if (!r.ok) wa.correo_error = `n8n respondió ${r.status}`;
      } catch (e) {
        wa.correo = false;
        wa.correo_error = String(e.message || e);
      }
    }

    return wa;
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

  // Aprobar las pruebas. Va por RPC y no por un update directo porque la
  // función además encola el WhatsApp al supervisor: si el front hiciera el
  // update, la aprobación quedaría y el aviso no, y el supervisor no sabría que
  // ahora le toca cargar el comprobante en Logistic.
  async function aprobarPruebas(t) {
    if (!t) return;
    const { data, error } = await sb.rpc("fn_pnr_aprobar_pruebas",
      { p_tarea_id: t.id, p_quien: "posventa", p_nota: null });
    if (error) { setError("No se pudo aprobar: " + error.message); return; }

    // Si la aprobación quedó pero el aviso falló, hay que decirlo: el
    // supervisor no se enteró y alguien tiene que avisarle a mano. Callarlo
    // haría creer que el mensaje salió.
    if (data && data.aviso_encolado === false) {
      setError("Pruebas aprobadas, pero el aviso al supervisor no salió: "
        + (data.error_aviso || "la ventana de 24 h puede estar cerrada"));
    }
    const { data: fresca } = await sb.from("pnr_tareas_mx")
      .select("*").eq("id", t.id).single();
    if (fresca) setTareas((prev) => ({ ...prev, [fresca.case_id]: fresca }));
  }

  // Los números conocidos de cada caso: MELI, el directorio de la torre y el
  // propio de Posventa. Se recarga al guardar uno nuevo para que aparezca sin
  // volver a cargar la pantalla.
  const cargarTelefonos = useCallback(async () => {
    const { data, error: e } = await sb.from("vw_pnr_telefonos").select("*").limit(5000);
    if (e || !data) return;
    const m = {};
    for (const t of data) {
      if (!m[t.case_id]) m[t.case_id] = [];
      m[t.case_id].push(t);
    }
    setTelefonos(m);
  }, []);

  // El elegido manda sobre el de más confianza: si el analista decidió usar
  // otro, el aviso no debería contradecirlo.
  function elegirTelefono(caseId, tel) {
    setTelElegidos((prev) => ({ ...prev, [caseId]: tel }));
  }

  function agregarTarea(t) {
    if (t) setTareas((prev) => ({ ...prev, [t.case_id]: t }));
  }

  // Al desplegar se marca como visto. El insert va sin await para que la fila
  // se abra de inmediato: si falla, el peor caso es que el badge no baje, y eso
  // se corrige en la próxima carga.
  function marcarVisto(caseId) {
    if (vistos.has(caseId)) return;
    setVistos((prev) => new Set(prev).add(caseId));
    sb.from("pnr_vistos_mx")
      .insert({ case_id: caseId, analista: "posventa" })
      .then(() => {});
  }

  function abrirFila(c) {
    const estaba = abiertas.has(c.case_id);
    if (!estaba) marcarVisto(c.case_id);
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
              {v.clave === "chat" && msjSinLeer > 0 && (
                <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700,
                  background: C.naranja, color: "#fff", borderRadius: 10,
                  padding: "1px 7px", verticalAlign: "middle" }}>
                  {msjSinLeer}
                </span>
              )}
            </button>
          ))}
        </div>
        {/* El buscador y el periodo son del tablero: en el chat no filtran nada
            y solo ocupan la barra con controles que no responden. */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {aviso && <span style={{ fontSize: 11.5, color: C.verde }}>{aviso}</span>}
          {vista === "chat" ? null : <Fragment>
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
          </Fragment>}
        </div>
      </div>

      {/* El chat ocupa el alto completo y no comparte pantalla con el tablero:
          son dos formas de trabajar distintas y mezclarlas dejaría las dos a
          media altura. */}
      {vista === "chat" ? (
        <div style={{ height: "calc(100vh - 150px)", minHeight: 420 }}>
          <ChatPosventa />
        </div>
      ) : vista === "tablero" ? (
        /* El tablero tiene su propio rango de fechas y no usa el selector de
           periodo de la barra: son dos preguntas distintas. El periodo sirve
           para cuadrar contra el portal de MELI, el rango para ver si la semana
           viene mejor que la anterior. */
        <TableroControl />
      ) : (
      <Fragment>

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
      <TablaEstados casos={delPeriodo} filtro={filtro} historial={historial}
        dia={diaMov} onDia={setDiaMov}
        onFiltrar={(clave) => { setBusqueda(""); setFiltro({ tipo: "estado", valor: clave }); setAbiertas(new Set()); }}
        onFiltrarMovidos={(clave) => { setBusqueda(""); setFiltro({ tipo: "movidos_estado", valor: clave }); setAbiertas(new Set()); }} />

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
            {buscando ? "Resultados"
              : filtro.tipo === "estado" ? (POR_ESTADO[filtro.valor] || {}).etiqueta || "Casos"
              : filtro.tipo === "movidos_estado"
                ? `Pasaron hoy a ${(POR_ESTADO[filtro.valor] || {}).etiqueta || filtro.valor}`
              : filtro.tipo === "movidos" ? "Movidos hoy"
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

          {/* Movidos hoy. Es el filtro que evita perseguir una foto de un caso
              que MELI ya anuló esta mañana. */}
          <button onClick={() => { setBusqueda(""); setFiltro({ tipo: "movidos", valor: null }); setAbiertas(new Set()); }}
            style={{
              fontSize: 11.5, padding: "4px 10px", borderRadius: 20, cursor: "pointer",
              border: "1px solid " + (!buscando && filtro.tipo === "movidos" ? C.naranja : "var(--borde)"),
              background: !buscando && filtro.tipo === "movidos" ? C.naranjaTenue : "#fff",
              color: !buscando && filtro.tipo === "movidos" ? C.naranja : "var(--texto-suave)",
              fontWeight: !buscando && filtro.tipo === "movidos" ? 600 : 400,
            }}>
            Movidos hoy
          </button>

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
              <ColOrden campo="sla" orden={orden} onClick={ordenar}>SLA · TRAMO</ColOrden>
              <span>Conductor</span>
              <span>Ruta · centro</span>
              <span style={{ textAlign: "center" }}>Estado</span>
              <span style={{ display: "grid", gridTemplateColumns: `repeat(${HITOS.length}, 1fr)`, gap: 2 }}>
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
                  onTareaCreada={agregarTarea} onRepedir={repedirPruebas} onAprobar={aprobarPruebas}
                  movimientos={historial[c.case_id]} sinVer={!vistos.has(c.case_id)}
                  fueraDePeriodo={!!periodo && c.periodo !== periodo}
                  telefonos={telefonos[c.case_id]} telElegido={telElegidos[c.case_id]}
                  onElegirTel={(t) => elegirTelefono(c.case_id, t)}
                  onTelGuardado={cargarTelefonos}
                  onNotificar={notificar} />
              ))
            )}
          </div>
        </div>
      </div>

      </Fragment>
      )}
    </div>
  );
}
