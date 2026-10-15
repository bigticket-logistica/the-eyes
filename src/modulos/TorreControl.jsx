import { useState, useEffect, useMemo, useCallback } from "react";
import { sb } from "../shared/supabase.js";

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
function Señales({ v }) {
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
  if (v.alertas > 0) {
    marcas.push(["ale", `${v.alertas} alerta${v.alertas > 1 ? "s" : ""}`, C.ambar]);
  }
  // Zona alta y media no piden lo mismo: una parada en zona alta vale más que
  // diez en media, y un contador solo no distingue.
  if (v.zona_alta) marcas.push(["zon", `zona alta · ${v.paradas_en_zona}`, C.rojo]);
  else if (v.zona_media) marcas.push(["zon", `zona media · ${v.paradas_en_zona}`, C.ambar]);

  if (!marcas.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 7, flexWrap: "wrap" }}>
      {marcas.map(([k, txt, col]) => (
        <span key={k} style={{ fontSize: 9.5, color: col, whiteSpace: "nowrap" }}>
          {txt}
        </span>
      ))}
    </span>
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
function Avance({ total, entregados }) {
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

  const esHoy = dia === hoyMx();

  const cargar = useCallback(async () => {
    const { data, error } = await sb.from("vw_torre_control_dia")
      .select("travel_id, sc, servicio, vehiculo, flota, estado, travel_status, "
            + "driver_name, vehicle_plate, ruta_id, ruta_nombre, ruta_paradas, "
            + "ruta_region, eta_visible, min_hasta_eta, "
            + "id_ruta, ruta_status, salida_real, min_atraso_salida, "
            + "pkg_total, pkg_delivered, chofer_cambiado, captura, captura_hora, "
            + "alertas, incidencias, incidencias_abiertas, pnr, pnr_monto, "
            + "paradas_en_zona, zona_alta, zona_media")
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

  const total = useMemo(() => centros.reduce((a, g) => ({
    rojo: a.rojo + g.rojo, ambar: a.ambar + g.ambar, verde: a.verde + g.verde,
  }), { rojo: 0, ambar: 0, verde: 0 }), [centros]);

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
                    {g.viajes.map((v) => {
                      const s = semaforo(v);
                      const falta = v.estado === "SIN_ASIGNAR" || v.estado === "POR_VENCER"
                                 || v.estado === "PERDIDO";
                      return (
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
                            {v.ruta_nombre ? (
                              <>
                                <div>{v.ruta_nombre}</div>
                                {v.ruta_paradas && (
                                  <div style={{ fontSize: 9.5, color: C.tenue }}>
                                    {v.ruta_paradas} paradas
                                  </div>
                                )}
                              </>
                            ) : v.id_ruta ? (
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                                #{v.id_ruta}
                              </span>
                            ) : (
                              <span style={{ color: C.tenue }}>—</span>
                            )}
                          </td>
                          {/* La celda de avance carga el estado cuando no hay
                              barra que dibujar. Antes había un guión que no
                              decía nada y una columna entera para decirlo. */}
                          <td style={{ padding: "5px 6px 5px 0" }}>
                            {v.id_ruta
                              ? <Avance total={v.pkg_total} entregados={v.pkg_delivered} />
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
                            <Señales v={v} />
                          </td>
                        </tr>
                      );
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
