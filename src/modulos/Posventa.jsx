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
  const e = POR_ESTADO[c.sub_estado];
  return e ? e.grupo : "responder";
}

const GRUPOS = [
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

function chipEstado(sub) {
  const e = POR_ESTADO[sub];
  if (!e) return { corto: sub, largo: sub, color: C.gris };
  return { corto: e.corto, largo: e.etiqueta, color: COLOR_GRUPO[e.grupo] || C.gris };
}

// Línea de cumplimiento del caso, en el orden en que debería ocurrir. Las dos
// últimas llegan de la vista actualizada; si todavía no corriste el SQL vienen
// undefined y se pintan como pendientes, sin romper nada.
const HITOS = [
  { clave: "avisado_inicial_en",   etiqueta: "Aviso 1", titulo: "Primer aviso al conductor" },
  { clave: "avisado_24h_en",       etiqueta: "Aviso 2", titulo: "Escalamiento al supervisor (24 h)" },
  { clave: "avisado_final_en",     etiqueta: "Aviso 3", titulo: "Escalamiento al dueño (40 h)" },
  { clave: "pruebas_recibidas_en", etiqueta: "Pruebas", titulo: "El conductor entregó las pruebas" },
  { clave: "comprobante_en",       etiqueta: "Cargado", titulo: "Comprobante cargado en MELI" },
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
              color: COLOR_GRUPO[e.grupo] || "var(--texto)" }}>
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

function Bloque({ titulo, children, tono }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: tono || "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        {titulo}
      </div>
      {children}
    </div>
  );
}

function Detalle({ c, onCopiar, onPedir, trayendo }) {
  const sinRuta = !c.conductor_ruta && !c.patente && !c.fecha_ruta;
  const sub = chipEstado(c.sub_estado);
  const hayDetalle = !!c.detalle_capturado_en && !c.detalle_error;

  // La defensa del caso en una línea. Si MELI registró la entrega en el
  // domicilio exacto y con constancia de quién recibió, el reclamo se pelea
  // solo — y eso hoy el analista lo descubre abriendo MELI caso por caso.
  const enDomicilio = /^A\s*0([.,]0+)?\s*km/i.test(c.distancia_texto || "");
  const defendible = enDomicilio && !!c.recibio_quien;

  return (
    <div style={{ padding: "12px 16px 14px 44px", background: C.grisTenue, borderTop: "1px solid var(--borde)" }}>
      <Bloque titulo="Caso">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
          <Dato etiqueta="Caso PNR" valor={c.case_id} />
          <Dato etiqueta="Guía" valor={c.shipment_id} />
          <Dato etiqueta="Ruta" valor={`${c.route_code || "—"} · ${c.route_id || "—"}`} />
          <Dato etiqueta="Centro" valor={c.service_center} />
          <Dato etiqueta="Nace" valor={c.cuando_mx} />
          <Dato etiqueta="Transcurrido" valor={c.horas_transcurridas != null ? `${Math.round(c.horas_transcurridas)} h` : null} />
          <Dato etiqueta="Estado MELI" valor={`${ESTADOS[c.estado] || c.estado} · ${sub.largo}`} />
          <Dato etiqueta="Responsable" valor={c.responsable} />
        </div>
      </Bloque>

      {hayDetalle && (
        <Fragment>
          <Bloque titulo="Datos del reclamo">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
              <div style={{ minWidth: 260, flex: 1 }}>
                <div style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase", letterSpacing: 0.3 }}>
                  Producto
                </div>
                <div style={{ fontSize: 12.5, color: "var(--texto)" }}>{c.producto || "—"}</div>
              </div>
              <Dato etiqueta="Valor" valor={c.valor_compra != null ? dinero(c.valor_compra) : null} />
              <Dato etiqueta="Reclamante" valor={c.reclamante} />
              <Dato etiqueta="Designado para recibir" valor={c.designado_recibir} />
            </div>
            {c.mensaje_reclamo && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--texto)", background: "#fff",
                border: "1px solid var(--borde)", borderRadius: 8, padding: "8px 10px" }}>
                “{c.mensaje_reclamo}”
              </div>
            )}
          </Bloque>

          {/* Prueba de entrega: el bloque que decide si el caso se pelea o se
              paga. Va antes que el contexto de ruta a propósito. */}
          <Bloque titulo="Prueba de entrega" tono={defendible ? C.verde : undefined}>
            {defendible && (
              <div style={{ fontSize: 12, color: C.verde, background: "#e9f3ef",
                border: `1px solid ${C.verde}`, borderRadius: 8, padding: "6px 10px", marginBottom: 8 }}>
                Entregado en el domicilio y con constancia de quién recibió.
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
              <Dato etiqueta="Fecha de entrega" valor={c.entregado_en} />
              <Dato etiqueta="Recibió" valor={c.recibio_quien} />
              <Dato etiqueta="Nombre" valor={c.recibio_nombre} />
              <Dato etiqueta="Documento" valor={c.recibio_documento} />
              <Dato etiqueta="Distancia" valor={c.distancia_texto} />
            </div>
          </Bloque>
        </Fragment>
      )}

      <Bloque titulo="Ruta y conductor">
        {sinRuta && !hayDetalle ? (
          <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>
            Sin captura de la ruta {c.route_id || "—"} en el monitor. Traé el detalle de MELI o buscala en Logistic.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
            <Dato etiqueta="Conductor" valor={c.transportista || c.conductor_ruta || c.conductor} />
            <Dato etiqueta="Teléfono" valor={c.telefono} />
            <Dato etiqueta="Transportadora" valor={c.transportadora} />
            <Dato etiqueta="Placa" valor={c.patente} />
            <Dato etiqueta="Fecha de ruta" valor={c.fecha_ruta} />
            <Dato etiqueta="Paquetes" valor={c.pkg_total != null ? `${c.pkg_delivered ?? 0} de ${c.pkg_total} · ${c.pkg_not_delivered ?? 0} no entregados` : null} />
          </div>
        )}
      </Bloque>

      <Bloque titulo="Cumplimiento">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
          {HITOS.map((h) => (
            <Dato key={h.clave} etiqueta={h.titulo} valor={fechaHito(c[h.clave]) || "Pendiente"} />
          ))}
        </div>
      </Bloque>

      {c.detalle_error && (
        <div style={{ fontSize: 11.5, color: C.ladrillo, background: C.ladrilloTenue,
          border: `1px solid ${C.ladrillo}`, borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
          No se pudo traer el detalle de MELI: {c.detalle_error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => onCopiar(String(c.case_id), "Caso copiado")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar caso</button>
        <button onClick={() => onCopiar(c.shipment_id, "Guía copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar guía</button>
        {c.telefono && (
          <button onClick={() => onCopiar(c.telefono, "Teléfono copiado")}
            style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar teléfono</button>
        )}
        <button onClick={() => onPedir(c.case_id, true)} disabled={trayendo}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>
          {trayendo ? "Trayendo de MELI…" : hayDetalle ? "Actualizar detalle" : "Traer detalle"}
        </button>
        <button disabled title="Falta definir plantilla y tiempos de escalonamiento"
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Avisar al conductor</button>
        {hayDetalle && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--texto-tenue)" }}>
            detalle de {fechaHito(c.detalle_capturado_en)}
          </span>
        )}
      </div>
    </div>
  );
}

function Fila({ c, abierta, onAbrir, onCopiar, onPedir, trayendo, ahora }) {
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
        <span style={{ minWidth: 0, fontSize: 13, color: "var(--texto)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
        <Riel c={c} color={g.color} terminal={g.terminal} fondo={fondo} />
        <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
          {dinero(c.monto)}
        </span>
      </div>
      {abierta && <Detalle c={c} onCopiar={onCopiar} onPedir={onPedir} trayendo={trayendo} />}
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

  async function cargar() {
    setError(null);
    const { data, error: err } = await sb
      .from("vw_pnr_detalle")
      .select("*")
      .limit(5000);
    if (err) setError(err.message);
    else setCasos(data || []);
    setCargando(false);
  }

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
    return base.slice().sort((a, b) => {
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
  function abrirFila(c) {
    const estaba = abiertas.has(c.case_id);
    setAbiertas((prev) => {
      const n = new Set(prev);
      if (estaba) n.delete(c.case_id); else n.add(c.case_id);
      return n;
    });
    if (!estaba && !detalleFresco(c) && !trayendo.has(c.case_id)) pedirDetalle(c.case_id, false);
  }

  function copiar(texto, mensaje) {
    navigator.clipboard.writeText(texto || "");
    setAviso(mensaje);
    setTimeout(() => setAviso(""), 1600);
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
                  onCopiar={copiar} onPedir={pedirDetalle}
                  trayendo={trayendo.has(c.case_id)} ahora={ahora} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
