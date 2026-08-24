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

// Regla de clasificación del dinero. Está acá arriba, en un solo lugar, porque
// es la definición del negocio y no un detalle de pintura: si mañana cambia
// qué sub_estado cuenta como salvado, se cambia acá y las tarjetas, el filtro
// y los totales quedan consistentes solos.
//
// Es un mapa completo y no una cadena de if a propósito. Con la cadena, el
// último return era el destino de todo lo que no calzaba antes, así que un
// sub_estado nuevo de MELI caía callado en "en gestión" y contaminaba una
// tarjeta que dice tener comprobante. Acá cada uno de los siete está escrito,
// y lo desconocido cae en riesgo: si MELI inventa un estado mañana, aparece
// arriba pidiendo que alguien lo mire en vez de esconderse en el medio.
const DESTINO = {
  WITHOUT_RECEIPT:  "riesgo",   // el conductor todavía no entregó nada
  WAITING_RECEIPT:  "riesgo",
  UPLOADED_RECEIPT: "gestion",  // el comprobante ya está cargado en MELI
  ON_REVIEW:        "gestion",
  ASSIGNED:         "gestion",
  TO_BILL:          "gestion",  // camino a facturación, pero todavía sin cerrar
  BILLED:           "perdido",   // "Enviado a facturación" en el panel de MELI
  NOT_BILLED:       "salvado",  // "Anulado" en el panel de MELI
};

function clasificar(c) {
  return DESTINO[c.sub_estado] || "riesgo";
}

const GRUPOS = [
  { clave: "riesgo",  etiqueta: "En riesgo", nota: "MELI espera pruebas",   color: C.naranja,  tinte: C.naranjaTenue,  terminal: false },
  { clave: "gestion", etiqueta: "En gestión", nota: "comprobante entregado", color: C.navy,     tinte: C.navyTenue,     terminal: false },
  { clave: "salvado", etiqueta: "Salvado",   nota: "anulado por MELI",      color: C.verde,    tinte: "#e9f3ef",       terminal: true },
  { clave: "perdido", etiqueta: "Perdido",   nota: "enviado a facturación", color: C.ladrillo, tinte: C.ladrilloTenue, terminal: true },
];

const POR_CLAVE = Object.fromEntries(GRUPOS.map((g) => [g.clave, g]));

const ESTADOS = { NEW: "Nuevo", IN_PROGRESS: "En curso", CLOSED: "Cerrado" };

// Etiquetas cortas: la columna es angosta y "Esperando comprobante" completo
// empujaba el resto de la fila. El texto largo queda en el detalle.
const SUBESTADOS = {
  WITHOUT_RECEIPT:  { corto: "Sin comprob.", largo: "Sin comprobante",       color: C.ladrillo },
  WAITING_RECEIPT:  { corto: "Esperando",    largo: "Esperando comprobante", color: C.naranja },
  UPLOADED_RECEIPT: { corto: "Subido",       largo: "Comprobante subido",    color: C.navy },
  ON_REVIEW:        { corto: "En revisión",  largo: "En revisión",           color: C.navy },
  ASSIGNED:         { corto: "Asignado",     largo: "Asignado",              color: C.navy },
  TO_BILL:          { corto: "Por cobrar",   largo: "Por cobrar",            color: C.naranja },
  BILLED:           { corto: "Cobrado",      largo: "Cobrado",               color: C.ladrillo },
  NOT_BILLED:       { corto: "No cobrado",   largo: "No cobrado",            color: C.verde },
};

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
const GRID = "14px 84px 84px minmax(130px,1fr) 128px 104px 296px 78px";

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

// El reloj sale de horas_restantes, que ya calcula la vista sobre las 48 h
// contadas desde fecha_caso. No se recalcula acá para que la pantalla y la
// base nunca digan cosas distintas.
//
// En un caso ya resuelto la cuenta regresiva no significa nada: MELI ya
// cobró o ya anuló, y las horas que faltaban dejaron de importar en ese
// momento. Antes seguía corriendo y ponía casos cobrados arriba de todo con
// un reloj naranja, que es justo lo contrario de lo que hay que mirar.
function reloj(c) {
  const g = POR_CLAVE[clasificar(c)];
  if (g && g.terminal) {
    return { texto: "—", color: C.gris, titulo: "Resuelto: el SLA dejó de correr" };
  }
  const horas = c.horas_restantes;
  if (horas === null || horas === undefined) return { texto: "—", color: C.gris, titulo: "" };
  if (horas <= 0) return { texto: `Vencido ${Math.abs(Math.round(horas))} h`, color: C.ladrillo, titulo: "" };
  if (horas < 6)  return { texto: `${horas.toFixed(1)} h`, color: C.ladrillo, titulo: "" };
  if (horas < 24) return { texto: `${Math.floor(horas)} h`, color: C.naranja, titulo: "" };
  return { texto: `${Math.floor(horas)} h`, color: C.navy, titulo: "" };
}

function Tarjeta({ grupo, monto, casos, activa, onClick }) {
  return (
    <button onClick={onClick} title={`Ver solo ${grupo.etiqueta.toLowerCase()}`}
      style={{
        flex: 1, minWidth: 178, textAlign: "left", cursor: "pointer",
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

// Panel de control, con el mismo formato del panel de MELI: Casos, Estado de
// los casos y Detalle de cierre. Los números salen de nuestra base, que es
// donde el analista los va a usar, y hoy son los mismos que publica MELI.
//
// No lleva conciliación ni marcas de frescura. Se probó y no servía: el
// desglose sale de los mismos casos de los dos lados, así que comparar era
// comparar un número contra sí mismo, y la única "diferencia" que aparecía
// era el desfase contra una foto vieja.
function pct(n, total) {
  if (!total) return "0%";
  return ((Number(n || 0) * 100) / total).toFixed(2) + "%";
}

function Linea({ etiqueta, valor, total }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 46px 56px", gap: 6,
      alignItems: "baseline", padding: "3px 0" }}>
      <span style={{ fontSize: 11.5, color: "var(--texto-suave)", minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {etiqueta}
      </span>
      <span style={{ textAlign: "right", fontSize: 11.5, fontWeight: 600, color: "var(--texto)",
        fontVariantNumeric: "tabular-nums" }}>
        {valor}
      </span>
      <span style={{ textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
        fontVariantNumeric: "tabular-nums" }}>
        {pct(valor, total)}
      </span>
    </div>
  );
}

function Panel({ titulo, children }) {
  return (
    <div style={{ flex: 1, minWidth: 230, background: "#fff", border: "1px solid var(--borde)",
      borderRadius: 12, padding: "11px 14px" }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--texto)", marginBottom: 6 }}>
        {titulo}
      </div>
      {children}
    </div>
  );
}

function Control({ casos }) {
  const total = casos.length;
  const est = { NEW: 0, IN_PROGRESS: 0, CLOSED: 0 };
  let anulado = 0, facturacion = 0;
  for (const c of casos) {
    if (est[c.estado] !== undefined) est[c.estado] += 1;
    if (c.sub_estado === "NOT_BILLED") anulado += 1;
    if (c.sub_estado === "BILLED") facturacion += 1;
  }
  // MELI saca los porcentajes del cierre sobre los cerrados, no sobre el
  // total. Si se dividiera por el total no cuadrarían contra su panel y
  // parecería un error nuestro.
  const cerrados = est.CLOSED;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
      <div style={{ width: 168, background: "#fff", border: "1px solid var(--borde)",
        borderRadius: 12, padding: "11px 14px", textAlign: "center",
        display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>Casos</div>
        <div style={{ fontSize: 30, fontWeight: 600, color: "var(--texto)", lineHeight: 1.35 }}>
          {total}
        </div>
      </div>

      <Panel titulo="Estado de los casos">
        <Linea etiqueta="Nuevo"             valor={est.NEW}         total={total} />
        <Linea etiqueta="Revisión en curso" valor={est.IN_PROGRESS} total={total} />
        <Linea etiqueta="Cerrado"           valor={est.CLOSED}      total={total} />
        <Linea etiqueta="Cancelado"         valor={0}               total={total} />
      </Panel>

      <Panel titulo="Detalle de cierre">
        <Linea etiqueta="Anulado"               valor={anulado}     total={cerrados} />
        <Linea etiqueta="Enviado a facturación" valor={facturacion} total={cerrados} />
      </Panel>
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
  const sub = SUBESTADOS[c.sub_estado] || { largo: c.sub_estado };
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

function Fila({ c, abierta, onAbrir, onCopiar, onPedir, trayendo }) {
  const r = reloj(c);
  const g = POR_CLAVE[clasificar(c)];
  const fondo = abierta ? C.grisTenue : "#fff";
  const sub = SUBESTADOS[c.sub_estado] || { corto: c.sub_estado, color: C.gris };
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
        <span title={r.titulo} style={{ fontSize: 12, fontWeight: 600, color: r.color, whiteSpace: "nowrap" }}>
          {r.texto}
        </span>
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
  const [grupo, setGrupo] = useState("riesgo");
  const [periodo, setPeriodo] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [abiertas, setAbiertas] = useState(new Set());
  const [aviso, setAviso] = useState("");
  const [trayendo, setTrayendo] = useState(new Set());

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
    const t = { riesgo: { monto: 0, n: 0 }, gestion: { monto: 0, n: 0 },
                salvado: { monto: 0, n: 0 }, perdido: { monto: 0, n: 0 } };
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
      : delPeriodo.filter((c) => grupo === "todos" || clasificar(c) === grupo);

    // Tres rangos, en orden de lo que hay que mirar primero: lo que todavía
    // tiene reloj corriendo, lo vencido pero todavía peleable, y lo ya
    // resuelto. Dentro del primero manda el reloj; en los otros dos manda el
    // monto, porque una vez que el SLA pasó o el caso cerró el reloj ya no
    // distingue nada y lo que decide es cuánta plata hay adentro.
    const rango = (c) => {
      const g = POR_CLAVE[clasificar(c)];
      if (g && g.terminal) return 2;
      return (c.horas_restantes ?? -9999) > 0 ? 0 : 1;
    };
    return base.slice().sort((a, b) => {
      const ra = rango(a), rb = rango(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return (a.horas_restantes ?? 0) - (b.horas_restantes ?? 0);
      return Number(b.monto || 0) - Number(a.monto || 0);
    });
  }, [casos, delPeriodo, grupo, busqueda, buscando]);

  // Se llama al desplegar la fila y desde el botón. Sin secreto configurado no
  // intenta: mejor un aviso claro que un fetch que falla en silencio.
  async function pedirDetalle(caseId, forzar) {
    if (!SECRETO_PNR) {
      setAviso("Falta VITE_PNR_API_SECRET");
      setTimeout(() => setAviso(""), 2500);
      return;
    }
    setTrayendo((s) => new Set(s).add(caseId));
    try {
      const r = await fetch(`${API_PNR}/pnr-detalle/${caseId}${forzar ? "?forzar=1" : ""}`,
        { headers: { "x-api-secret": SECRETO_PNR } });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "sin detalle");
      // Se mezcla en memoria en vez de recargar toda la lista: la fila está
      // abierta y una recarga la cerraría de golpe delante del analista.
      setCasos((prev) => prev.map((x) => x.case_id === caseId
        ? { ...x, ...soloDetalle(j.detalle), detalle_capturado_en: j.detalle.capturado_en, detalle_error: j.detalle.error || null }
        : x));
    } catch (e) {
      setCasos((prev) => prev.map((x) => x.case_id === caseId
        ? { ...x, detalle_error: String(e.message || e) } : x));
    } finally {
      setTrayendo((s) => { const n = new Set(s); n.delete(caseId); return n; });
    }
  }

  function abrirFila(c) {
    // Varias filas pueden quedar abiertas: el analista compara casos del mismo
    // conductor o de la misma ruta, y cerrarle la anterior cada vez lo obliga
    // a memorizar lo que acaba de leer.
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
            activa={!buscando && grupo === g.clave}
            onClick={() => { setBusqueda(""); setGrupo(g.clave); setAbiertas(new Set()); }} />
        ))}
      </div>

      {/* Mismo formato que el panel de MELI, con los números de nuestra base. */}
      <Control casos={delPeriodo} />

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
            {buscando ? "Resultados" : (GRUPOS.find((g) => g.clave === grupo) || {}).etiqueta || "Todos"}
          </span>
          <button onClick={() => { setBusqueda(""); setGrupo("todos"); setAbiertas(new Set()); }}
            style={{
              fontSize: 11.5, padding: "4px 10px", borderRadius: 20, cursor: "pointer",
              border: "1px solid " + (!buscando && grupo === "todos" ? C.navy : "var(--borde)"),
              background: !buscando && grupo === "todos" ? C.navyTenue : "#fff",
              color: !buscando && grupo === "todos" ? C.navy : "var(--texto-suave)",
              fontWeight: !buscando && grupo === "todos" ? 600 : 400,
            }}>
            Todos
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--texto-tenue)" }}>
            {lista.length} en pantalla · {buscando ? "todos los periodos" : "por vencer primero, después por monto"}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 1060 }}>
            {/* Cabecera de columnas: sin esto los cinco tildes no se sabe qué
                marcan. Usa la misma plantilla de grid que las filas. */}
            <div style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "6px 16px",
              borderTop: "1px solid var(--borde)", background: C.grisTenue,
              fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
              color: "var(--texto-tenue)", fontWeight: 600,
            }}>
              <span />
              <span>Caso</span>
              <span>SLA 48 h</span>
              <span>Conductor</span>
              <span>Ruta · centro</span>
              <span style={{ textAlign: "center" }}>Estado</span>
              <span style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>
                {HITOS.map((h) => (
                  <span key={h.clave} title={h.titulo} style={{ textAlign: "center" }}>{h.etiqueta}</span>
                ))}
              </span>
              <span style={{ textAlign: "right" }}>Monto</span>
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
                  trayendo={trayendo.has(c.case_id)} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
