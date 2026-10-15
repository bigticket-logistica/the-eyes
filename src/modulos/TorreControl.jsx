import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from "react";
import { sb } from "../shared/supabase.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ═══════════════════════════════════════════════════════════════════════════
// TORRE DE CONTROL MX
//
// QUÉ ES EL ROSTERING Y POR QUÉ IMPORTA
//   MELI acepta un viaje y el supervisor tiene que asignarle tres cosas:
//   chofer, placa y ruta. Si alguna falta cuando llega la hora de la cita, el
//   vehículo no sale y MELI lo cuenta como no ejecutado. Hasta ahora nadie
//   miraba eso hasta que ya había pasado.
//
// POR QUÉ LO MALO VA ARRIBA
//   Un tablero ordenado alfabéticamente obliga a leerlo entero para encontrar
//   el problema. Acá el centro con lo peor sube solo, y el que está completo
//   se hunde al fondo. Si todo está verde, no hay nada que leer.
//
// LOS TRES COLORES
//   rojo      falta chofer o placa — el rostering ni empezó
//   amarillo  tiene chofer y placa pero no tiene ruta — quedó a medias
//   verde     completo, operando o terminado
//
//   El amarillo existe porque es el caso que no se veía: en la pantalla de
//   MELI dice "Rutas no asignadas" y el supervisor cree que ya terminó.
//
// EL RELOJ VA CONTRA LA CITA, NO CONTRA EL LOCKDATE
//   MELI da de plazo técnico la cita + 10 horas (eran 16 hasta junio, lo
//   cambiaron). Pero rosterizar a las 20:00 un viaje que debía cargar a las
//   07:00 no lo salva: el camión no salió igual. El plazo real es la cita, y
//   eso es lo que cuenta el contador.
//
// LAS CINCO SEÑALES
//   rostering     chofer, placa y ruta del viaje planificado
//   operación     si salió, a qué hora y cómo va su avance
//   incidencias   casos de MELI sobre esa ruta, abiertas y cerradas
//   PNR           reclamos abiertos con su monto en riesgo
//   polígonos     si la ruta pasó por una zona peligrosa
//
//   Las cuatro últimas son marcas en la fila, no estados. El semáforo del SC
//   significa una sola cosa —el supervisor tiene algo que responder en
//   bitácora— y si un PNR también pintara rojo, esa claridad se pierde.
//
// DE DÓNDE SALEN LOS DATOS
//   vw_torre_control_dia, que se arma con la captura más reciente de
//   meli_rostering_planificado — una cada 5 minutos — cruzada con
//   rutas_monitoreo_mx para el avance real.
//
//   El estado NO se deduce del cruce: sale de travelStatus, que es lo que MELI
//   dice del viaje. La versión anterior adivinaba por placa y marcaba como no
//   salidos a cinco choferes que estaban en ruta.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  verde:    "#1D9E75",
  verdeBg:  "#E1F5EE",
  // El naranja de Bigticket, no un ámbar genérico: #BA7517 se lee café y
  // rompe con el resto de la Torre.
  ambar:    "#C25A08",
  ambarBg:  "#FDEEDF",
  rojo:     "#E24B4A",
  rojoBg:   "#FCEBEB",
  gris:     "var(--texto-suave)",
  tenue:    "var(--texto-tenue)",
};

// Un viaje cae en un solo semáforo. El orden de la evaluación es el orden de
// gravedad: primero lo que ya no tiene arreglo, al final lo que está bien.
// Rojo es lo que el supervisor tiene que responder en bitácora. Son dos
// preguntas distintas y las dos terminan en plata:
//
//   sin ruta   el viaje nunca se ruteó y tampoco operó — puede ser una
//              cancelación que nadie registró
//   no salió   tenía chofer, placa y ruta, y la camioneta no se movió —
//              puede ser un no show
//
// El atraso NO entra. Un viaje que salió 47 minutos tarde salió: los paquetes
// se mueven y no hay nada que explicar. Marcarlo en color competía con los
// dos de arriba, que son los que de verdad hay que contestar.
//
// SIN_RUTEAR solo se dispara cuando tampoco hay ruta operando: un viaje con
// carga en la calle nunca cae ahí aunque el supervisor no haya cerrado el
// campo en MELI. Esa distinción la hace la vista, no esta función.
function semaforo(v) {
  if (v.estado === "NO_SALIO" || v.estado === "PERDIDO"
   || v.estado === "SIN_ASIGNAR" || v.estado === "SIN_RUTEAR"
   || v.estado === "CANCELADO") return "rojo";
  if (v.estado === "POR_VENCER") return "ambar";
  return "verde";
}

const ETIQUETA = {
  PERDIDO:         "cita vencida",
  NO_SALIO:        "no salió",
  SIN_ASIGNAR:     "sin chofer ni placa",
  POR_VENCER:      "por vencer",
  SIN_RUTEAR:      "sin ruta",
  POR_SALIR:       "por salir",
  OPERANDO:        "en ruta",
  TERMINADO:       "terminado",
  SALIO_RETRASADO: "en ruta",
  CANCELADO:       "cancelado",
};

// El contador hacia la cita. En negativo se lee como atraso, no como tiempo
// restante: "hace 2:15" dice algo distinto que "-2:15".
// Día y hora en formato de México, corto. Las incidencias traen timestamp
// completo y en la tabla solo cabe lo justo.
function fechaCorta(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false });
}

function reloj(min) {
  if (min == null) return "—";
  const m = Math.abs(Math.round(min));
  const txt = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  return min < 0 ? `hace ${txt}` : txt;
}

// Las cuatro señales de la fila. Van juntas en una celda y cada una aparece
// solo si tiene algo que decir: una fila limpia no muestra nada, y así el ojo
// se va directo a las que sí.
//
// Ninguna cambia el color del renglón. Son avisos de "mira esto", no estados
// del viaje: el rojo está reservado para lo que va a bitácora.
function Señales({ v, onPanel }) {
  const marcas = [];
  if (v.incidencias_abiertas > 0) {
    marcas.push(["inc", `${v.incidencias_abiertas} abierta${v.incidencias_abiertas > 1 ? "s" : ""}`, C.rojo]);
  } else if (v.incidencias > 0) {
    marcas.push(["inc", `${v.incidencias} cerrada${v.incidencias > 1 ? "s" : ""}`, C.tenue]);
  }
  if (v.pnr > 0) {
    marcas.push(["pnr", `${v.pnr} PNR`
      + (v.pnr_monto > 0 ? ` $${Math.round(v.pnr_monto).toLocaleString("es-MX")}` : ""), C.rojo]);
  }
  // Las alertas por su nombre y no como número: "2 alertas" no dice si hay
  // que llamar al chofer o esperar. La inactividad del vehículo va en rojo
  // porque significa que la camioneta no se mueve.
  if (v.alerta_inactividad_vehiculo) marcas.push(["det", "detenida", C.rojo]);
  if (v.alerta_ruta_demorada)        marcas.push(["dem", "demorada", C.ambar]);
  if (v.alerta_despacho_demorado)    marcas.push(["des", "despacho tarde", C.ambar]);
  if (v.alerta_stemout_demorado)     marcas.push(["sto", "stem-out tarde", C.ambar]);
  // El resto de las siete alertas de MELI, sin desglosar: saca pendiente y
  // parada comercial son menos urgentes y no justifican una etiqueta propia.
  const nombradas = (v.alerta_inactividad_vehiculo ? 1 : 0) + (v.alerta_ruta_demorada ? 1 : 0)
    + (v.alerta_despacho_demorado ? 1 : 0) + (v.alerta_stemout_demorado ? 1 : 0);
  if (v.alertas > nombradas) {
    marcas.push(["ale", `+${v.alertas - nombradas}`, C.tenue]);
  }
  // Zona alta y media no piden lo mismo: una parada en zona alta vale más que
  // diez en media, y un contador solo no distingue.
  if (v.zona_alta) marcas.push(["zon", `zona alta · ${v.paradas_en_zona}`, C.rojo]);
  else if (v.zona_media) marcas.push(["zon", `zona media · ${v.paradas_en_zona}`, C.ambar]);

  if (!marcas.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 7, flexWrap: "wrap" }}>
      {marcas.map(([k, txt, col]) => {
        // Incidencias y zona abren panel; las alertas no, porque de ellas
        // solo tenemos el booleano y no habría nada que mostrar adentro.
        const abre = k === "inc" ? "inc" : k === "zon" ? "zona" : null;
        if (!abre) {
          return (
            <span key={k} style={{ fontSize: 9.5, color: col, whiteSpace: "nowrap" }}>
              {txt}
            </span>
          );
        }
        return (
          <button key={k} onClick={(e) => { e.stopPropagation(); onPanel(abre); }}
            style={{ fontSize: 9.5, color: col, whiteSpace: "nowrap", border: "none",
              background: "none", padding: 0, cursor: "pointer",
              textDecoration: "underline", textDecorationStyle: "dotted",
              textUnderlineOffset: 2, fontFamily: "inherit" }}>
            {txt}
          </button>
        );
      })}
    </span>
  );
}

// Un indicador del día. El color solo aparece cuando el número pide atención:
// un cero en "detenidas" no necesita ser verde para que se entienda que está
// bien, y pintar todo de colores hace que ninguno destaque.
function Kpi({ titulo, valor, sub, color }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)",
      borderRadius: 10, padding: "9px 14px", minWidth: 128 }}>
      <div style={{ fontSize: 10.5, color: C.gris }}>{titulo}</div>
      <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.2,
        color: color || "inherit" }}>{valor}</div>
      <div style={{ fontSize: 10, color: C.tenue }}>{sub}</div>
    </div>
  );
}

// ── Panel de zona peligrosa ────────────────────────────────────────────────
//   El mapa con el polígono, la camioneta y las paradas. Se pide aparte y solo
//   al abrir: vw_seg_rutas_en_zona trae el arreglo completo de paradas con sus
//   coordenadas, y cargarlo para las trece rutas de un día sería traer miles
//   de puntos que nadie va a mirar.
function PanelZona({ idRuta, fecha }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const div = useRef(null);
  const mapa = useRef(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error } = await sb.from("vw_seg_rutas_en_zona")
        .select("zonas, paradas, veh_lat, veh_lng, veh_metros_a_zona, "
              + "paradas_en_zona, en_zona_pendientes, conductor_nombre, placa")
        .eq("fecha", fecha).eq("ruta_id", idRuta).maybeSingle();
      if (!vivo) return;
      if (error) { setErr(error.message); return; }
      setD(data);
    })();
    return () => { vivo = false; };
  }, [idRuta, fecha]);

  useEffect(() => {
    if (!d || !div.current || mapa.current) return;
    const pts = (d.paradas || []).filter((p) => p.lat && p.lng);
    if (!pts.length && !d.veh_lat) return;

    const m = L.map(div.current, { attributionControl: false, zoomControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 19 }).addTo(m);

    // Pendiente en ámbar, entregada en verde apagado. El que importa es el
    // pendiente: es el paquete que todavía hay que ir a dejar ahí adentro.
    for (const p of pts) {
      const pend = p.estado !== "complete";
      L.circleMarker([p.lat, p.lng], {
        radius: pend ? 5 : 3.5,
        color: pend ? "#C25A08" : "#1D9E75",
        fillColor: pend ? "#C25A08" : "#1D9E75",
        fillOpacity: pend ? 0.9 : 0.35, weight: 1,
      }).addTo(m).bindTooltip(
        `#${p.secuencia} · ${pend ? "pendiente" : "entregado"}<br>${p.envio_id}`,
        { direction: "top" });
    }

    const todos = pts.map((p) => [p.lat, p.lng]);
    if (d.veh_lat && d.veh_lng) {
      L.circleMarker([d.veh_lat, d.veh_lng], {
        radius: 7, color: "#1a3a6b", fillColor: "#1a3a6b",
        fillOpacity: 1, weight: 2,
      }).addTo(m).bindTooltip("camioneta", { direction: "top" });
      todos.push([d.veh_lat, d.veh_lng]);
    }
    if (todos.length) m.fitBounds(L.latLngBounds(todos).pad(0.25));
    mapa.current = m;
    // El contenedor nace dentro de un bloque que se acaba de desplegar, así
    // que leaflet mide mal el alto si no se le dice que vuelva a mirar.
    setTimeout(() => m.invalidateSize(), 80);
    return () => { m.remove(); mapa.current = null; };
  }, [d]);

  if (err) return <div style={{ fontSize: 11, color: C.rojo, padding: 8 }}>{err}</div>;
  if (!d) return <div style={{ fontSize: 11, color: C.tenue, padding: 8 }}>Cargando zona…</div>;

  const zonas = d.zonas || [];
  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11,
        marginBottom: 7 }}>
        {zonas.map((z) => (
          <span key={z.id} style={{ fontWeight: 600,
            color: z.nivel === "alto" ? C.rojo : C.ambar }}>
            {z.nombre} · {z.nivel}
          </span>
        ))}
        <span style={{ color: C.gris }}>
          {d.paradas_en_zona} paradas en zona · {d.en_zona_pendientes} pendientes
        </span>
        {d.veh_metros_a_zona != null && (
          <span style={{ color: d.veh_metros_a_zona < 200 ? C.rojo : C.gris }}>
            {/* Menos de 200 metros es estar adentro para efectos prácticos:
                el GPS tiene ese margen de error. */}
            camioneta a {d.veh_metros_a_zona} m
          </span>
        )}
      </div>
      <div ref={div} style={{ height: 260, borderRadius: 8, overflow: "hidden",
        border: "1px solid var(--borde)" }} />
    </div>
  );
}

// ── Panel de incidencias ───────────────────────────────────────────────────
//   Los casos de MELI sobre esa ruta. Las etiquetas vienen en null en los
//   casos recién creados —MELI las completa después— así que se traducen los
//   ids, que sí llegan siempre.
const MOTIVO = {
  BAD_ADDRESS: "Domicilio incorrecto",
  BUYER_ABSENT: "No había nadie",
  CLOSED_BUSINESS: "Negocio cerrado",
  NOT_IN_MY_ZONE: "Fuera de zona",
};
const ESTADO_INC = {
  NEW: "Nueva", OPEN: "Abierta", ON_HOLD: "En espera",
  CHECKING: "Revisando", CLOSED: "Cerrada", CANCELLED: "Anulada",
};

function PanelIncidencias({ idRuta }) {
  const [filas, setFilas] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data } = await sb.from("crm_inc_casos")
        .select("case_id, motivo_id, motivo_label, estado_id, estado_label, "
              + "prioridad, fecha_caso, direccion_entrega, avance_ruta")
        .eq("route_id", String(idRuta))
        .order("fecha_caso", { ascending: false });
      if (vivo) setFilas(data || []);
    })();
    return () => { vivo = false; };
  }, [idRuta]);

  if (!filas) return <div style={{ fontSize: 11, color: C.tenue, padding: 8 }}>Cargando…</div>;
  if (!filas.length) return <div style={{ fontSize: 11, color: C.tenue, padding: 8 }}>Sin incidencias.</div>;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11,
      marginTop: 4 }}>
      <tbody>
        {filas.map((f) => {
          const abierta = ["NEW","OPEN","ON_HOLD","CHECKING"].includes(f.estado_id);
          const dir = f.direccion_entrega || {};
          return (
            <tr key={f.case_id} style={{ borderTop: "1px solid var(--borde)" }}>
              <td style={{ padding: "4px 8px 4px 0", fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap", color: C.tenue }}>#{f.case_id}</td>
              <td style={{ padding: "4px 8px", fontWeight: abierta ? 600 : 400 }}>
                {f.motivo_label || MOTIVO[f.motivo_id] || f.motivo_id || "—"}
              </td>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap",
                color: abierta ? C.rojo : C.tenue }}>
                {f.estado_label || ESTADO_INC[f.estado_id] || f.estado_id}
              </td>
              <td style={{ padding: "4px 8px", color: C.gris, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}
                title={[dir.calle, dir.numero, dir.barrio, dir.ciudad].filter(Boolean).join(", ")}>
                {[dir.calle, dir.numero].filter(Boolean).join(" ") || "—"}
              </td>
              <td style={{ padding: "4px 0 4px 8px", color: C.tenue, whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums" }}>
                {f.fecha_caso ? fechaCorta(f.fecha_caso) : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Punto({ color }) {
  const c = color === "rojo" ? C.rojo : color === "ambar" ? C.ambar : C.verde;
  return <span style={{ display: "inline-block", width: 9, height: 9,
    borderRadius: "50%", background: c, flexShrink: 0 }} />;
}

function Pill({ color, children }) {
  const m = { rojo: [C.rojoBg, C.rojo], ambar: [C.ambarBg, C.ambar], verde: [C.verdeBg, C.verde] };
  const [bg, fg] = m[color] || m.verde;
  return (
    <span style={{ background: bg, color: fg, fontSize: 10.5, fontWeight: 600,
      padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

// Barra de avance de la ruta. Solo aparece si la ruta existe y tiene paquetes:
// una barra en cero para un viaje que no arrancó se lee como "va mal" cuando
// en realidad todavía no empieza.
function Avance({ total, entregados, fallidos }) {
  if (!total) return <span style={{ fontSize: 11, color: C.tenue }}>—</span>;
  const pct = Math.round((entregados / total) * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 70, height: 5, borderRadius: 3, background: "var(--borde)",
        overflow: "hidden", flexShrink: 0 }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%",
          background: pct >= 95 ? C.verde : "var(--navy, #1a3a6b)" }} />
      </span>
      <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: C.gris }}>
        {entregados}/{total}
        {/* Los no entregados al lado y en ámbar: un 90% de avance con quince
            fallidos no es el mismo día que un 90% limpio. */}
        {fallidos > 0 && (
          <span style={{ color: C.ambar }}> · {fallidos} fallidos</span>
        )}
      </span>
    </span>
  );
}

// La fecha operativa de México, que es la que importa: a las 00:30 de Chile
// en México todavía es el día anterior y el rostering vigente es el de ayer.
function hoyMx() {
  return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

export default function TorreControl() {
  const [dia, setDia] = useState(hoyMx);
  const [filas, setFilas] = useState(null);
  const [error, setError] = useState(null);
  const [abiertos, setAbiertos] = useState(new Set());
  // Un solo panel abierto a la vez, identificado por viaje y tipo: dos mapas
  // montados al mismo tiempo pelean por el alto del contenedor.
  const [panel, setPanel] = useState(null);

  const esHoy = dia === hoyMx();

  const cargar = useCallback(async () => {
    const { data, error } = await sb.from("vw_torre_control_dia")
      .select("travel_id, sc, servicio, vehiculo, flota, estado, travel_status, "
            + "driver_name, vehicle_plate, ruta_id, ruta_nombre, ruta_paradas, "
            + "ruta_region, eta_visible, min_hasta_eta, "
            + "id_ruta, ruta_status, salida_real, min_atraso_salida, "
            + "pkg_total, pkg_delivered, chofer_cambiado, captura, captura_hora, "
            + "alertas, incidencias, incidencias_abiertas, pnr, pnr_monto, "
            + "paradas_en_zona, zona_alta, zona_media, pkg_not_delivered, "
            + "alerta_ruta_demorada, alerta_inactividad_vehiculo, "
            + "alerta_despacho_demorado, alerta_stemout_demorado")
      .eq("fecha_operativa", dia)
      .order("sc").order("eta_visible");
    if (error) { setError(error.message); return; }
    setError(null);
    setFilas(data || []);
  }, [dia]);

  useEffect(() => {
    cargar();
    // El refresco automático solo corre sobre el día de hoy. Un día cerrado ya
    // no cambia, y recargarlo cada minuto es tráfico que no aporta.
    if (!esHoy) return;
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 60000);
    return () => clearInterval(t);
  }, [cargar, esHoy]);

  // Agrupado por centro, con el peor semáforo arriba. Dentro de cada centro
  // los viajes también van por gravedad: el analista abre el rojo y lo primero
  // que ve es lo que tiene que resolver.
  const centros = useMemo(() => {
    if (!filas) return [];
    const m = new Map();
    for (const v of filas) {
      if (!m.has(v.sc)) m.set(v.sc, { sc: v.sc, viajes: [], rojo: 0, ambar: 0, verde: 0,
        inc: 0, pnr: 0, ale: 0, zonaAlta: 0, zonaMedia: 0 });
      const g = m.get(v.sc);
      g.viajes.push(v);
      g[semaforo(v)]++;
      // Las señales también se suman al centro: con todo plegado, el detalle
      // de la fila no se ve, y un tablero que obliga a abrir trece centros
      // para saber dónde hay algo no es un tablero.
      g.inc  += v.incidencias_abiertas || 0;
      g.pnr  += v.pnr || 0;
      g.ale  += v.alertas || 0;
      if (v.zona_alta)  g.zonaAlta++;
      if (v.zona_media) g.zonaMedia++;
    }
    const peso = { rojo: 0, ambar: 1, verde: 2 };
    return [...m.values()].map((g) => ({
      ...g,
      color: g.rojo ? "rojo" : g.ambar ? "ambar" : "verde",
      viajes: g.viajes.sort((a, b) =>
        peso[semaforo(a)] - peso[semaforo(b)]
        || (a.min_hasta_eta ?? 0) - (b.min_hasta_eta ?? 0)),
    })).sort((a, b) =>
      peso[a.color] - peso[b.color] || b.rojo - a.rojo
      // Después del rostering ordena lo que de verdad está pasando en la
      // calle: incidencias abiertas, reclamos y zonas peligrosas. Un centro
      // en verde con tres incidencias sube sobre uno limpio.
      || (b.inc + b.pnr + b.zonaAlta) - (a.inc + a.pnr + a.zonaAlta)
      || b.ambar - a.ambar || a.sc.localeCompare(b.sc));
  }, [filas]);

  // ── Los indicadores del día ─────────────────────────────────────────────
  //   Salen de las mismas filas que el tablero, no de otra consulta: así no
  //   puede pasar que el encabezado diga una cosa y el detalle otra, que es el
  //   problema clásico de tener dos pantallas con la misma información.
  //
  //   Solo cuentan los viajes que tienen ruta operando. Un viaje sin ruta no
  //   tiene paquetes ni avance, y meterlo en el denominador hunde el
  //   porcentaje sin que nadie haya hecho nada mal.
  const kpi = useMemo(() => {
    if (!filas) return null;
    const conRuta = filas.filter((f) => f.id_ruta);
    const sum = (k) => conRuta.reduce((a, f) => a + (f[k] || 0), 0);
    const cargados = sum("pkg_total");
    return {
      cargados,
      entregados: sum("pkg_delivered"),
      pct: cargados ? Math.round((sum("pkg_delivered") / cargados) * 100) : 0,
      rutas: conRuta.length,
      activas: conRuta.filter((f) => f.ruta_status === "active").length,
      cerradas: conRuta.filter((f) => f.ruta_status === "close").length,
      detenidas: conRuta.filter((f) => f.alerta_inactividad_vehiculo).length,
      // Tres alertas distintas que significan lo mismo para quien mira: la
      // carga no se está moviendo como debería.
      demoradas: conRuta.filter((f) => f.alerta_ruta_demorada
        || f.alerta_despacho_demorado || f.alerta_stemout_demorado).length,
      fallidos: sum("pkg_not_delivered"),
    };
  }, [filas]);

  // Las rutas con alerta de todos los centros juntas. Van arriba y fuera del
  // acordeón porque son lo que pasa AHORA en la calle: si están repartidas en
  // trece centros plegados, nadie las ve hasta que ya es tarde.
  //
  // Detenida primero: la camioneta sin actividad es lo único de esta lista
  // donde cada minuto cuenta.
  const conAlerta = useMemo(() => {
    if (!filas) return [];
    return filas.filter((f) => f.id_ruta && f.alertas > 0)
      .sort((a, b) =>
        (b.alerta_inactividad_vehiculo ? 1 : 0) - (a.alerta_inactividad_vehiculo ? 1 : 0)
        || b.alertas - a.alertas
        || (a.pkg_delivered / (a.pkg_total || 1)) - (b.pkg_delivered / (b.pkg_total || 1)));
  }, [filas]);

  const total = useMemo(() => centros.reduce((a, g) => ({
    rojo: a.rojo + g.rojo, ambar: a.ambar + g.ambar, verde: a.verde + g.verde,
  }), { rojo: 0, ambar: 0, verde: 0 }), [centros]);

  const abrirPanel = (travelId, tipo) => setPanel((p) =>
    p && p.id === travelId && p.tipo === tipo ? null : { id: travelId, tipo });

  const alternar = (sc) => setAbiertos((s) => {
    const n = new Set(s);
    n.has(sc) ? n.delete(sc) : n.add(sc);
    return n;
  });

  // ── La descarga ─────────────────────────────────────────────────────────
  //   CSV con punto y coma y BOM, no xlsx. Excel en español lee la coma como
  //   separador decimal: con comas, "104, 106" entra en una sola columna, y
  //   sin el BOM los acentos salen rotos. Esto se abre con doble clic.
  function descargar() {
    if (!filas || !filas.length) return;
    const cols = ["sc", "travel_id", "estado", "eta_visible", "driver_name",
      "vehicle_plate", "ruta_nombre", "ruta_paradas", "ruta_region", "id_ruta",
      "salida_real", "min_atraso_salida", "pkg_total", "pkg_delivered",
      "servicio", "flota", "travel_status", "chofer_cambiado"];
    const esc = (v) => {
      if (v == null) return "";
      const t = String(v);
      return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const txt = "\uFEFF" + [cols.join(";"),
      ...filas.map((f) => cols.map((c) => esc(f[c])).join(";"))].join("\n");
    const url = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    // La fecha va en el nombre: tres descargas de días distintos no pueden
    // quedar como rostering.csv, (1) y (2).
    a.download = `rostering_${dia}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) {
    return <div style={{ padding: 20, color: C.rojo, fontSize: 13 }}>
      No se pudo cargar el rostering: {error}
    </div>;
  }
  if (filas === null) {
    return <div style={{ padding: 20, color: C.gris, fontSize: 13 }}>Cargando…</div>;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "14px 18px" }}>

      {/* ── Resumen ──────────────────────────────────────────────────────
          Tres cifras y nada más. Si rojo y ámbar están en cero, la jornada
          está limpia y no hace falta abrir ningún centro. */}
      <div style={{ display: "flex", alignItems: "center", gap: 18,
        marginBottom: 12, whiteSpace: "nowrap" }}>
        <strong style={{ fontSize: 14 }}>Rostering</strong>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Punto color="rojo" />
          <span style={{ fontSize: 13, fontWeight: 700, color: total.rojo ? C.rojo : C.tenue }}>
            {total.rojo}
          </span>
          <span style={{ fontSize: 11.5, color: C.gris }}>piden respuesta</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Punto color="ambar" />
          <span style={{ fontSize: 13, fontWeight: 700, color: total.ambar ? C.ambar : C.tenue }}>
            {total.ambar}
          </span>
          <span style={{ fontSize: 11.5, color: C.gris }}>por vencer</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Punto color="verde" />
          <span style={{ fontSize: 13, fontWeight: 700, color: C.verde }}>{total.verde}</span>
          <span style={{ fontSize: 11.5, color: C.gris }}>en regla</span>
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 11, color: C.tenue, whiteSpace: "nowrap" }}>
            {/* La etiqueta de la corrida, no la hora en que se escribió la
                fila: una pasada que arranca 19:55 y demora dos minutos
                termina escribiendo 19:57, y eso no es una captura. */}
            {filas[0]?.captura ? `captura ${filas[0].captura}` : ""}
          </span>
          {/* El día se elige acá. Hasta 30 días atrás, que es lo que guarda la
              vista; más atrás los datos existen pero no se consultan. */}
          <input type="date" value={dia} max={hoyMx()}
            onChange={(e) => { setDia(e.target.value); setFilas(null); setAbiertos(new Set()); }}
            style={{ fontSize: 11.5, padding: "3px 6px", borderRadius: 7,
              border: "1px solid var(--borde)", background: "#fff" }} />
          <button onClick={descargar} disabled={!filas?.length}
            style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 7,
              border: "1px solid var(--borde)", background: "#fff",
              cursor: filas?.length ? "pointer" : "default",
              color: filas?.length ? "inherit" : C.tenue }}>
            Descargar
          </button>
        </span>
      </div>

      {/* Los indicadores del día, antes del tablero. Responden "cómo va la
          operación"; el tablero de abajo responde "dónde hay que meterse". */}
      {kpi && kpi.rutas > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <Kpi titulo="Avance de reparto" valor={`${kpi.pct}%`}
            sub={`${kpi.entregados.toLocaleString("es-MX")} / ${kpi.cargados.toLocaleString("es-MX")} paquetes`}
            color="var(--navy)" />
          <Kpi titulo="Rutas operando" valor={kpi.rutas}
            sub={`${kpi.activas} en ruta · ${kpi.cerradas} cerradas`} />
          <Kpi titulo="Detenidas" valor={kpi.detenidas} sub="vehículo sin actividad"
            color={kpi.detenidas ? C.rojo : C.verde} />
          <Kpi titulo="Demoradas" valor={kpi.demoradas} sub="ruta, despacho o stem-out"
            color={kpi.demoradas ? C.ambar : C.verde} />
          <Kpi titulo="No entregados" valor={kpi.fallidos.toLocaleString("es-MX")}
            sub="reparto de hoy" color={kpi.fallidos ? C.ambar : undefined} />
        </div>
      )}

      {/* ── Rutas con alerta ─────────────────────────────────────────────
          Lo que está pasando en la calle, antes del tablero por centro. */}
      {conAlerta.length > 0 && (
        <div style={{ border: `1px solid ${C.ambar}`, borderRadius: 11,
          marginBottom: 12, overflow: "hidden", background: "#fff" }}>
          <div style={{ padding: "8px 13px", background: C.ambarBg,
            display: "flex", alignItems: "baseline", gap: 10 }}>
            <strong style={{ fontSize: 13, color: C.ambar }}>
              {conAlerta.length} ruta{conAlerta.length > 1 ? "s" : ""} con alerta
            </strong>
            <span style={{ fontSize: 11, color: C.gris }}>
              {kpi?.detenidas > 0 && `${kpi.detenidas} detenida${kpi.detenidas > 1 ? "s" : ""} · `}
              {kpi?.demoradas > 0 && `${kpi.demoradas} con demora · `}
              cualquier alerta de MELI
            </span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5,
            tableLayout: "fixed" }}>
            <thead>
              <tr style={{ color: C.tenue, textAlign: "left", fontSize: 9.5,
                textTransform: "uppercase", letterSpacing: 0.3 }}>
                <th style={{ fontWeight: 600, padding: "5px 6px 5px 13px", width: "15%" }}>Ruta</th>
                <th style={{ fontWeight: 600, padding: "5px 6px", width: "9%" }}>SC</th>
                <th style={{ fontWeight: 600, padding: "5px 6px", width: "22%" }}>Conductor</th>
                <th style={{ fontWeight: 600, padding: "5px 6px", width: "12%" }}>Placa</th>
                <th style={{ fontWeight: 600, padding: "5px 6px", width: "21%" }}>Avance</th>
                <th style={{ fontWeight: 600, padding: "5px 13px 5px 6px" }}>Alertas</th>
              </tr>
            </thead>
            <tbody>
              {conAlerta.flatMap((v) => [
                <tr key={v.travel_id} style={{ borderTop: "1px solid var(--borde)",
                  background: v.alerta_inactividad_vehiculo ? C.rojoBg : "transparent" }}>
                  {/* El id numérico arriba porque es con lo que se busca en
                      Monitoreo y en el buscador de casos; el nombre abajo en
                      chico, que sirve para ubicarse pero no para pegar. */}
                  <td style={{ padding: "6px 6px 6px 13px", fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <div>{v.id_ruta || "—"}</div>
                    {v.ruta_nombre && (
                      <div style={{ fontSize: 9.5, color: C.tenue }}>{v.ruta_nombre}</div>
                    )}
                  </td>
                  <td style={{ padding: "6px", fontWeight: 600 }}>{v.sc}</td>
                  <td style={{ padding: "6px", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v.chofer_ruta || v.driver_name || "—"}
                  </td>
                  <td style={{ padding: "6px", fontVariantNumeric: "tabular-nums",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v.vehicle_plate || "—"}
                  </td>
                  <td style={{ padding: "6px" }}>
                    <Avance total={v.pkg_total} entregados={v.pkg_delivered}
                      fallidos={v.pkg_not_delivered} />
                  </td>
                  <td style={{ padding: "6px 13px 6px 6px" }}>
                    <Señales v={v} onPanel={(t) => abrirPanel(v.travel_id, t)} />
                  </td>
                </tr>,
                panel && panel.id === v.travel_id ? (
                  <tr key={`${v.travel_id}-p`}>
                    <td colSpan={6} style={{ padding: "0 13px 10px",
                      background: "var(--fondo, #fafafa)" }}>
                      {panel.tipo === "zona"
                        ? <PanelZona idRuta={v.id_ruta} fecha={dia} />
                        : <PanelIncidencias idRuta={v.id_ruta} />}
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      )}

      {centros.length === 0 && (
        <div style={{ fontSize: 13, color: C.gris }}>No hay viajes en la captura.</div>
      )}

      {centros.map((g) => {
        const open = abiertos.has(g.sc);
        const borde = g.color === "rojo" ? C.rojo : g.color === "ambar" ? C.ambar : "var(--borde)";
        return (
          <div key={g.sc} style={{ border: `1px solid ${borde}`, borderRadius: 11,
            marginBottom: 8, overflow: "hidden", background: "#fff" }}>

            {/* Cabecera del centro: el semáforo y el desglose. Plegada por
                defecto — el tablero se lee de un vistazo y se abre solo lo
                que hay que trabajar. */}
            <button onClick={() => alternar(g.sc)}
              style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                background: g.color === "rojo" ? C.rojoBg : g.color === "ambar" ? C.ambarBg : "transparent",
                padding: "9px 13px", display: "flex", alignItems: "center", gap: 11,
                flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: C.gris }}>{open ? "▾" : "▸"}</span>
              <Punto color={g.color} />
              <strong style={{ fontSize: 13, minWidth: 64 }}>{g.sc}</strong>
              {/* Ancho fijo: "1 viaje" y "7 viajes" miden distinto y las
                  pastillas de la derecha quedaban desalineadas entre filas. */}
              <span style={{ fontSize: 11.5, color: C.gris, minWidth: 62,
                display: "inline-block" }}>
                {g.viajes.length} viaje{g.viajes.length > 1 ? "s" : ""}
              </span>
              {g.rojo > 0 && <Pill color="rojo">{g.rojo} sin resolver</Pill>}
              {g.ambar > 0 && <Pill color="ambar">{g.ambar} por vencer</Pill>}
              {g.rojo === 0 && g.ambar === 0 && g.inc === 0 && g.pnr === 0
                && g.zonaAlta === 0 && <Pill color="verde">en regla</Pill>}

              {/* Las señales del centro, a la derecha y en texto, no en
                  pastilla: son avisos de "mira esto", y una pastilla las
                  pondría al mismo nivel que el estado del rostering, que es
                  lo único que va a bitácora. */}
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10,
                paddingRight: 4 }}>
                {g.inc > 0 && (
                  <span style={{ fontSize: 11, color: C.rojo }}>
                    {g.inc} incidencia{g.inc > 1 ? "s" : ""}
                  </span>
                )}
                {g.pnr > 0 && (
                  <span style={{ fontSize: 11, color: C.rojo }}>{g.pnr} PNR</span>
                )}
                {g.zonaAlta > 0 ? (
                  <span style={{ fontSize: 11, color: C.rojo }}>
                    {g.zonaAlta} en zona alta
                  </span>
                ) : g.zonaMedia > 0 ? (
                  <span style={{ fontSize: 11, color: C.ambar }}>
                    {g.zonaMedia} en zona media
                  </span>
                ) : null}
                {g.ale > 0 && (
                  <span style={{ fontSize: 11, color: C.ambar }}>
                    {g.ale} alerta{g.ale > 1 ? "s" : ""}
                  </span>
                )}
              </span>
            </button>

            {open && (
              <div style={{ padding: "0 13px 10px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5,
                  tableLayout: "fixed" }}>
                  <thead>
                    <tr style={{ color: C.tenue, textAlign: "left", fontSize: 9.5,
                      textTransform: "uppercase", letterSpacing: 0.3 }}>
                      <th style={{ fontWeight: 600, padding: "4px 6px 5px 0", width: "9%" }}>Cita</th>
                      <th style={{ fontWeight: 600, padding: "4px 6px 5px 0", width: "21%" }}>Chofer</th>
                      <th style={{ fontWeight: 600, padding: "4px 6px 5px 0", width: "12%" }}>Placa</th>
                      <th style={{ fontWeight: 600, padding: "4px 6px 5px 0", width: "16%" }}>Ruta</th>
                      <th style={{ fontWeight: 600, padding: "4px 6px 5px 0", width: "19%" }}>Avance</th>
                      <th style={{ fontWeight: 600, padding: "4px 0 5px 0" }}>Señales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.viajes.flatMap((v) => {
                      const s = semaforo(v);
                      const falta = v.estado === "SIN_ASIGNAR" || v.estado === "POR_VENCER"
                                 || v.estado === "PERDIDO";
                      return [
                        <tr key={v.travel_id} style={{ borderTop: "1px solid var(--borde)",
                          // La fila con problema va teñida: una pastilla sola
                          // se pierde cuando hay quince renglones.
                          background: s === "rojo" ? C.rojoBg : s === "ambar" ? C.ambarBg : "transparent" }}>
                          <td style={{ padding: "5px 6px 5px 0", whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums" }}>
                            <div>{(v.eta_visible || "").slice(0, 5)}</div>
                            {/* El contador solo donde hay algo que correr: en un
                                viaje terminado el tiempo restante no significa nada. */}
                            {falta && (
                              <div style={{ fontSize: 9.5, color: v.min_hasta_eta < 0 ? C.rojo : C.ambar }}>
                                {reloj(v.min_hasta_eta)}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "5px 6px 5px 0", overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={v.driver_name || ""}>
                            {v.driver_name || <span style={{ color: C.rojo }}>sin chofer</span>}
                            {/* Si la ruta la está manejando otra persona, el
                                rostering quedó desactualizado. */}
                            {v.chofer_cambiado && (
                              <div style={{ fontSize: 9.5, color: C.ambar }}>
                                en ruta va otro
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "5px 6px 5px 0", fontVariantNumeric: "tabular-nums",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {v.vehicle_plate || <span style={{ color: C.rojo }}>sin placa</span>}
                          </td>
                          {/* Esta columna identifica, no evalúa. Primero el
                              nombre del rostering; si el supervisor no cerró
                              ese campo pero la ruta existe igual, va su id,
                              que es con lo que se busca en Monitoreo.
                              Decir "sin ruta" al lado de una barra al 80% era
                              ruido: la ruta está, lo que falta es el papeleo. */}
                          <td style={{ padding: "5px 6px 5px 0", overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={v.ruta_region || ""}>
                            {v.id_ruta || v.ruta_nombre ? (
                              <>
                                <div style={{ fontVariantNumeric: "tabular-nums" }}>
                                  {v.id_ruta || v.ruta_nombre}
                                </div>
                                <div style={{ fontSize: 9.5, color: C.tenue }}>
                                  {[v.id_ruta ? v.ruta_nombre : null,
                                    v.ruta_paradas ? `${v.ruta_paradas} paradas` : null]
                                    .filter(Boolean).join(" · ")}
                                </div>
                              </>
                            ) : (
                              <span style={{ color: C.tenue }}>—</span>
                            )}
                          </td>
                          {/* La celda de avance carga el estado cuando no hay
                              barra que dibujar. Antes había un guión que no
                              decía nada y una columna entera para decirlo. */}
                          <td style={{ padding: "5px 6px 5px 0" }}>
                            {v.id_ruta
                              ? <Avance total={v.pkg_total} entregados={v.pkg_delivered}
                                  fallidos={v.pkg_not_delivered} />
                              : <span style={{ fontSize: 11, fontWeight: s === "verde" ? 400 : 600,
                                  color: s === "rojo" ? C.rojo : s === "ambar" ? C.ambar : C.gris }}>
                                  {ETIQUETA[v.estado] || v.estado}
                                </span>}
                            {/* El atraso se informa en gris, como dato. En
                                color competía con las alertas reales. */}
                            {v.estado === "SALIO_RETRASADO" && (
                              <div style={{ fontSize: 9.5, color: C.tenue }}>
                                salió {v.min_atraso_salida} min tarde
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "5px 0" }}>
                            <Señales v={v} onPanel={(t) => abrirPanel(v.travel_id, t)} />
                          </td>
                        </tr>,
                        panel && panel.id === v.travel_id ? (
                          <tr key={`${v.travel_id}-p`}>
                            <td colSpan={6} style={{ padding: "0 0 10px",
                              background: "var(--fondo, #fafafa)" }}>
                              {panel.tipo === "zona"
                                ? <PanelZona idRuta={v.id_ruta} fecha={dia} />
                                : <PanelIncidencias idRuta={v.id_ruta} />}
                            </td>
                          </tr>
                        ) : null,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
