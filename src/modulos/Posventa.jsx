import { Fragment, useState, useEffect, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ── Posventa ───────────────────────────────────────────────────────────────
// Hoy solo PNR; las devoluciones entran después como una segunda vista del
// mismo módulo. Lee vw_pnr_tablero completa (155 filas hoy, unos pocos miles
// en el peor caso) y agrega en el cliente: una consulta por carga en vez de
// tres RPC de totales que después habría que mantener sincronizadas a mano
// con la misma regla de clasificación.

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

// Control contra el panel de MELI, con el mismo desglose que publican ellos.
// Cada línea trae las dos cifras: la de MELI y la nuestra. Copiar el panel
// idéntico se vería mejor pero no serviría de nada — el valor de tenerlo acá
// es poder ver en qué fila exacta nos separamos, no repetir un número que ya
// está a un clic de distancia en su sitio.
//
// "Motivo de los casos" no está: los 198 son Reclamo PNR al 100%, así que el
// bloque ocupa una tarjeta entera para decir siempre lo mismo. Si algún día
// aparece otro motivo, vuelve.
function pct(n, total) {
  if (!total) return "0%";
  return ((Number(n || 0) * 100) / total).toFixed(2) + "%";
}

function Linea({ etiqueta, meli, propio, total }) {
  const difiere = propio !== null && propio !== undefined && Number(meli || 0) !== Number(propio);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2.5px 0" }}>
      <span style={{ flex: 1, fontSize: 11.5, color: "var(--texto-suave)", minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {etiqueta}
      </span>
      {difiere && (
        <span title="Lo que tenemos nosotros" style={{ fontSize: 11, fontWeight: 600, color: C.naranja }}>
          {propio}
        </span>
      )}
      <span style={{ fontSize: 11.5, fontWeight: 600, color: difiere ? C.naranja : "var(--texto)",
        fontVariantNumeric: "tabular-nums" }}>
        {meli ?? "—"}
      </span>
      <span style={{ width: 48, textAlign: "right", fontSize: 11, color: "var(--texto-tenue)",
        fontVariantNumeric: "tabular-nums" }}>
        {pct(meli, total)}
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

function Control({ fila, casos }) {
  if (!fila) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginTop: 14 }}>
        Sin control contra el panel de MELI. Falta que pnr-mx.cjs escriba en pnr_control_mx.
      </div>
    );
  }

  // Los mismos cortes que hace MELI, calculados sobre lo que tenemos guardado.
  const propio = { NEW: 0, IN_PROGRESS: 0, CLOSED: 0 };
  let anulado = 0, facturacion = 0;
  for (const c of casos) {
    if (propio[c.estado] !== undefined) propio[c.estado] += 1;
    if (c.sub_estado === "NOT_BILLED") anulado += 1;
    if (c.sub_estado === "BILLED") facturacion += 1;
  }

  // Una captura vieja que dice "calza" es la única forma en que este control
  // puede mentir: el scraper puede llevar horas caído y el panel seguiría
  // mostrando el último número bueno. Pasados 20 minutos —cuatro ciclos— deja
  // de afirmar nada y avisa que está mirando una foto vieja.
  const min = Math.round((Date.now() - new Date(fila.capturado_en).getTime()) / 60000);
  const vieja = min > 20;
  const hace = min < 1 ? "hace menos de 1 min"
             : min < 60 ? `hace ${min} min`
             : min < 2880 ? `hace ${Math.round(min / 60)} h`
             : `hace ${Math.round(min / 1440)} días`;
  const total = Number(fila.total_meli || 0);
  const cerrados = Number(fila.est_cerrado || 0);
  const calza = fila.brecha_total === 0;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
      <div style={{ width: 168, background: "#fff", border: "1px solid var(--borde)",
        borderRadius: 12, padding: "11px 14px", textAlign: "center" }}>
        <div style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>Casos en MELI</div>
        <div style={{ fontSize: 30, fontWeight: 600, color: "var(--texto)", lineHeight: 1.35 }}>
          {total}
        </div>
        <div style={{ fontSize: 11, color: calza && !vieja ? C.verde : C.naranja }}>
          {vieja ? "control desactualizado"
                 : calza ? "calzamos"
                 : `nosotros ${fila.total_base}`}
        </div>
        <div style={{ fontSize: 10, color: vieja ? C.naranja : "var(--texto-tenue)", marginTop: 2 }}>
          {hace}
        </div>
      </div>

      <Panel titulo="Estado de los casos">
        <Linea etiqueta="Nuevo"            meli={fila.est_nuevo}     propio={propio.NEW}         total={total} />
        <Linea etiqueta="Revisión en curso" meli={fila.est_revision} propio={propio.IN_PROGRESS} total={total} />
        <Linea etiqueta="Cerrado"          meli={fila.est_cerrado}   propio={propio.CLOSED}      total={total} />
        <Linea etiqueta="Cancelado"        meli={fila.est_cancelado} propio={null}               total={total} />
      </Panel>

      <Panel titulo="Detalle de cierre">
        <Linea etiqueta="Anulado"               meli={fila.cierre_anulado}     propio={anulado}     total={cerrados} />
        <Linea etiqueta="Enviado a facturación" meli={fila.cierre_facturacion} propio={facturacion} total={cerrados} />
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

function Detalle({ c, onCopiar }) {
  const sinRuta = !c.conductor_ruta && !c.patente && !c.fecha_ruta;
  const sub = SUBESTADOS[c.sub_estado] || { largo: c.sub_estado };
  return (
    <div style={{ padding: "12px 16px 14px 44px", background: C.grisTenue, borderTop: "1px solid var(--borde)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        <Dato etiqueta="Caso PNR" valor={c.case_id} />
        <Dato etiqueta="Guía" valor={c.shipment_id} />
        <Dato etiqueta="Ruta" valor={`${c.route_code || "—"} · ${c.route_id || "—"}`} />
        <Dato etiqueta="Centro" valor={c.service_center} />
        <Dato etiqueta="Nace" valor={c.cuando_mx} />
        <Dato etiqueta="Transcurrido" valor={c.horas_transcurridas != null ? `${Math.round(c.horas_transcurridas)} h` : null} />
        <Dato etiqueta="Estado MELI" valor={`${ESTADOS[c.estado] || c.estado} · ${sub.largo}`} />
        <Dato etiqueta="Periodo" valor={c.periodo} />
      </div>

      {/* Contexto de la ruta. Viene del cruce por route_id con la última
          captura histórica de rutas_monitoreo_mx; si no cruzó se dice, no se
          esconde: un caso sin ruta es justamente el que hay que ir a buscar
          a mano a Logistic. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Contexto de la ruta
      </div>
      {sinRuta ? (
        <div style={{ fontSize: 12, color: "var(--texto-tenue)", marginBottom: 12 }}>
          Sin captura de la ruta {c.route_id || "—"} en el monitor. Hay que buscarla en Logistic.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
          <Dato etiqueta="Conductor de ruta" valor={c.conductor_ruta} />
          <Dato etiqueta="Placa" valor={c.patente} />
          <Dato etiqueta="Fecha de ruta" valor={c.fecha_ruta} />
          <Dato etiqueta="Estado" valor={c.estado_ruta} />
          <Dato etiqueta="Paquetes" valor={c.pkg_total != null ? `${c.pkg_delivered ?? 0} de ${c.pkg_total} · ${c.pkg_not_delivered ?? 0} no entregados` : null} />
        </div>
      )}

      {/* Los mismos hitos de la fila, acá con el nombre largo. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Cumplimiento
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        {HITOS.map((h) => (
          <Dato key={h.clave} etiqueta={h.titulo} valor={fechaHito(c[h.clave]) || "Pendiente"} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onCopiar(String(c.case_id), "Caso copiado")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar caso</button>
        <button onClick={() => onCopiar(c.shipment_id, "Guía copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar guía</button>
        <button onClick={() => onCopiar(c.route_code || "", "Ruta copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar ruta</button>
        <button disabled title="Falta definir plantilla y tiempos de escalonamiento"
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Avisar al conductor</button>
      </div>
    </div>
  );
}

function Fila({ c, abierta, onAbrir, onCopiar }) {
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
      {abierta && <Detalle c={c} onCopiar={onCopiar} />}
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
  const [abierta, setAbierta] = useState(null);
  const [aviso, setAviso] = useState("");
  const [control, setControl] = useState([]);

  async function cargar() {
    setError(null);
    const [tablero, ctrl] = await Promise.all([
      sb.from("vw_pnr_tablero").select("*").limit(5000),
      sb.from("vw_pnr_control").select("*"),
    ]);
    if (tablero.error) setError(tablero.error.message);
    else setCasos(tablero.data || []);
    // El control es opcional a propósito: si todavía no existe la tabla o el
    // scraper no la escribió, la pantalla funciona igual y solo pierde la
    // franja de conciliación. No vale tumbar el tablero por un chequeo.
    setControl(ctrl.error ? [] : (ctrl.data || []));
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
          <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); setAbierta(null); }}
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
          No se pudo leer vw_pnr_tablero: {error}
        </div>
      )}

      {/* Las tarjetas son el filtro. Un tablero de plata donde el número y el
          botón que lo abre son la misma cosa: se toca el monto que interesa y
          la lista de abajo queda con esos casos. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        {GRUPOS.map((g) => (
          <Tarjeta key={g.clave} grupo={g} monto={totales[g.clave].monto} casos={totales[g.clave].n}
            activa={!buscando && grupo === g.clave}
            onClick={() => { setBusqueda(""); setGrupo(g.clave); setAbierta(null); }} />
        ))}
      </div>

      {/* Control contra el panel de MELI. Es la única parte de la pantalla que
          puede decir "nos falta algo": todo lo demás describe lo que ya
          trajimos, y un scraper que se pierde casos se ve idéntico a un día
          tranquilo. */}
      <Control fila={control.find((c) => c.periodo === periodo)} casos={delPeriodo} />

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
            {buscando ? "Resultados" : (GRUPOS.find((g) => g.clave === grupo) || {}).etiqueta || "Todos"}
          </span>
          <button onClick={() => { setBusqueda(""); setGrupo("todos"); setAbierta(null); }}
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
                <Fila key={c.case_id} c={c} abierta={abierta === c.case_id}
                  onAbrir={() => setAbierta(abierta === c.case_id ? null : c.case_id)}
                  onCopiar={copiar} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
