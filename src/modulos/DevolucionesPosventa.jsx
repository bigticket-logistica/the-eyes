import { Fragment, useState, useEffect, useMemo, useCallback } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// DEVOLUCIONES · vista dentro de Posventa
//
// QUÉ MUESTRA
//   Por día operativo, cada ruta que quedó 100% gestionada con paquetes a
//   devolver. Una fila por ruta; al desplegar, un renglón por folio con las
//   tres marcas: foto, georreferencia y registro en MELI.
//
// DE DÓNDE SALE CADA COSA
//   Rutas, conductor, placa, SC     → rutas_monitoreo_mx (la torre), última
//                                     captura del día. Es la fuente: la torre
//                                     ya sabe todo esto y no se vuelve a pedir.
//   Folios a devolver y marca MELI  → dev_paquetes_mx, que llenan dev-rutas
//                                     (clasificación) y dev-retorno (retorno).
//   SleepOver, plazo, cierre        → dev_rutas_mx, que es lo único que la
//                                     torre no calcula.
//   Supervisor                      → vw_pnr_supervisor por estacion_origen,
//                                     igual que PNR.
//   Foto y geo                      → dev_pruebas_mx, cuando el canal de
//                                     WhatsApp empiece a llenarla. Hoy quedan
//                                     pendientes; ver marcasDePruebas().
//
// LA FILA MADRE DICE UNA COSA: SI MELI YA REGISTRÓ LA DEVOLUCIÓN
//   Verde cuando todos los folios de la ruta tienen retorno confirmado en
//   MELI. Rojo cuando la ruta cerró y falta alguno. Foto y geo no cambian el
//   color de la fila: son declaraciones del conductor y se ven al desplegar.
//   MELI es la prueba dura, así que es la que manda arriba.
//
//   El SleepOver tiene su propio estado, en ámbar, con la hora de vencimiento.
//   No es rojo porque no está incumpliendo: está en su plazo. Pasado el plazo
//   sin cerrar, ahí sí es rojo.
//
//   Una ruta abierta sin SleepOver no es alerta: el conductor va en camino.
//
// SIN FK ENTRE TABLAS
//   Mundos separados: torre, devoluciones y PNR no se referencian. Se piden
//   las cuatro fuentes aparte y se cruzan acá por id_ruta y por SC.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1a3a6b", navyTenue: "#eef2f8",
  naranja: "#F47B20", naranjaTenue: "#fdf1e6",
  ladrillo: "#9e3b1b", ladrilloTenue: "#faece6",
  verde: "#1f7a5c", verdeTenue: "#eaf5f1",
  gris: "#8a94a6", grisTenue: "#f4f6f9",
};

function hoyMX() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function horaMX(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-MX", {
    timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fechaHoraMX(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Los tres bloques del encabezado. Devoluciones es el único con datos hoy; los
// otros dos quedan como marcadores hasta que se defina qué contienen.
const BLOQUES = [
  { clave: "devoluciones",      etiqueta: "Devoluciones",       activo: true },
  { clave: "descontenerizacion", etiqueta: "Descontenerización", activo: false },
  { clave: "otros",             etiqueta: "Otros",              activo: false },
];

// ── Foto y geo: adaptador sobre dev_pruebas_mx ─────────────────────────────
// El canal de WhatsApp todavía no llena dev_pruebas_mx, así que hoy toda marca
// de foto y geo sale "pendiente". Cuando el canal esté andando, esta función
// es lo único que hay que tocar: recibe las filas de dev_pruebas_mx y devuelve
// por folio { foto: true|false, geo: true|false|null }.
//
// geo en null = el centro no tiene coordenadas y la prueba se acepta sin
// validar, que es la regla del módulo: nunca se rechaza a un conductor por un
// dato que falta de nuestro lado.
function marcasDePruebas(filasPruebas) {
  const m = new Map();
  for (const p of filasPruebas || []) {
    if (p.folio_guia == null) continue;
    const k = String(p.folio_guia);
    const previa = m.get(k) || { foto: false, geo: null };
    if (p.vision_veredicto === "SIRVE" || p.aprobada_en) previa.foto = true;
    if (p.geo_ok === true) previa.geo = true;
    else if (p.geo_ok === false && previa.geo !== true) previa.geo = false;
    m.set(k, previa);
  }
  return m;
}

// ── Estado de la fila madre ────────────────────────────────────────────────

function estadoRuta(r, folios, ahora) {
  const total = folios.length;
  const conf = folios.filter((f) => f.meli_retorno_en).length;
  const faltan = total - conf;

  if (total > 0 && faltan === 0) {
    return { clave: "registrada", texto: `Registrada · ${conf}/${total}`,
             color: C.verde, tinte: C.verdeTenue, icono: "✓" };
  }
  const vence = r.vence_en ? new Date(r.vence_en).getTime() : null;
  if (r.sleep_over_en && !r.cierre_en) {
    if (vence && ahora < vence) {
      return { clave: "sleepover", texto: `Sleepover · vence ${horaMX(r.vence_en)}`,
               color: C.naranja, tinte: C.naranjaTenue, icono: "☾" };
    }
    return { clave: "vencida", texto: `Sleepover vencido · ${conf}/${total}`,
             color: C.ladrillo, tinte: C.ladrilloTenue, icono: "!" };
  }
  if (!r.cierre_en) {
    return { clave: "en_ruta", texto: `En ruta · ${conf}/${total}`,
             color: C.gris, tinte: C.grisTenue, icono: "→" };
  }
  return { clave: "sin_registrar", texto: `Sin registrar · faltan ${faltan}`,
           color: C.ladrillo, tinte: C.ladrilloTenue, icono: "!" };
}

// ── Piezas visuales ────────────────────────────────────────────────────────

function Pill({ color, tinte, children, titulo }) {
  return (
    <span title={titulo} style={{ display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11.5, fontWeight: 600, color, background: tinte,
      border: `1px solid ${color}33`, borderRadius: 7, padding: "3px 9px",
      whiteSpace: "nowrap" }}>{children}</span>
  );
}

// Tres estados, no dos. El guion gris ("no aplica") existe para que una marca
// que no corresponde no se lea como incumplimiento.
function Marca({ estado, titulo }) {
  const p = {
    ok:        { fondo: C.verdeTenue, borde: C.verde, texto: C.verde, simbolo: "✓" },
    pendiente: { fondo: "#fff",       borde: C.gris,  texto: C.gris,  simbolo: "◌" },
    no_aplica: { fondo: C.grisTenue,  borde: C.gris,  texto: C.gris,  simbolo: "—" },
    mal:       { fondo: C.ladrilloTenue, borde: C.ladrillo, texto: C.ladrillo, simbolo: "✕" },
  }[estado] || { fondo: "#fff", borde: C.gris, texto: C.gris, simbolo: "◌" };
  return (
    <span title={titulo} style={{ display: "inline-flex", alignItems: "center",
      justifyContent: "center", width: 28, height: 22, borderRadius: 6,
      fontSize: 12, fontWeight: 700, background: p.fondo, color: p.texto,
      border: `1px solid ${p.borde}55`, cursor: "help" }}>{p.simbolo}</span>
  );
}

const GRID_RUTA = "18px 104px minmax(160px,1fr) 62px 160px 190px";
const GRID_FOLIO = "120px minmax(140px,1fr) 78px 110px 110px";

function FilaRuta({ r, folios, sup, pruebas, abierta, alternar, ahora }) {
  const est = estadoRuta(r, folios, ahora);
  return (
    <div style={{ borderTop: "1px solid var(--borde)" }}>
      <button onClick={alternar} style={{
        display: "grid", gridTemplateColumns: GRID_RUTA, gap: 10, alignItems: "center",
        width: "100%", padding: "9px 12px", textAlign: "left", border: "none",
        borderRadius: 0, background: abierta ? C.navyTenue : "#fff", cursor: "pointer",
      }}>
        <span style={{ color: C.gris, fontSize: 10 }}>{abierta ? "▼" : "▶"}</span>
        <span style={{ fontWeight: 700, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
          {r.id_ruta}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.driver_name}>
            {r.driver_name || "sin conductor"}
          </span>
          <span style={{ display: "block", fontSize: 10.5, color: C.gris }}>
            {r.vehicle_license || "sin placa"}
          </span>
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.navy }}>
          {r.service_center_id || "—"}
        </span>
        <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap" }} title={sup ? `${sup.nombre || ""} ${sup.telefono || ""}`.trim() : ""}>
          {sup && sup.nombre ? sup.nombre : <span style={{ color: C.gris }}>sin supervisor</span>}
        </span>
        <span style={{ display: "flex", justifyContent: "flex-end" }}>
          <Pill color={est.color} tinte={est.tinte}
            titulo={r.cierre_en ? `Cerró ${fechaHoraMX(r.cierre_en)}` : "La ruta sigue abierta en MELI"}>
            <span>{est.icono}</span>{est.texto}
          </Pill>
        </span>
      </button>

      {abierta && (
        <div style={{ background: C.grisTenue, padding: "6px 12px 10px 40px" }}>
          <div style={{ display: "grid", gridTemplateColumns: GRID_FOLIO, gap: 10,
            fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase",
            color: C.gris, padding: "4px 8px 6px" }}>
            <span>Paquete</span><span>Motivo</span>
            <span style={{ textAlign: "center" }}>Fotos</span>
            <span style={{ textAlign: "center" }}>Georreferencia</span>
            <span style={{ textAlign: "center" }}>Sistema MELI</span>
          </div>
          {folios.map((f) => {
            const pr = pruebas.get(String(f.folio_guia)) || { foto: false, geo: null };
            const recibio = (f.meli_personas || []).find((x) => x.proceso === "return_to_station"
              || x.proceso === "fraud_at_station") || (f.meli_personas || [])[0];
            return (
              <div key={f.id} style={{ display: "grid", gridTemplateColumns: GRID_FOLIO, gap: 10,
                alignItems: "center", padding: "6px 8px", borderRadius: 7, background: "#fff",
                marginBottom: 3, fontSize: 12 }}>
                <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{f.folio_guia}</span>
                <span style={{ color: "var(--texto-suave, #55607a)", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.incidente || f.substatus || ""}>
                  {f.incidente || f.substatus || "—"}
                </span>
                <span style={{ textAlign: "center" }}>
                  <Marca estado={pr.foto ? "ok" : "pendiente"}
                    titulo={pr.foto ? "Foto validada por Vision" : "Sin foto todavía"} />
                </span>
                <span style={{ textAlign: "center" }}>
                  {/* La geo se comparte para todos los folios de la misma visita al
                      centro: es una sola ubicación que el conductor mandó una vez. */}
                  <Marca estado={pr.geo === true ? "ok" : pr.geo === false ? "mal" : "pendiente"}
                    titulo={pr.geo === true ? "Ubicación dentro del radio del centro"
                      : pr.geo === false ? "Ubicación fuera del radio del centro"
                      : "Sin ubicación todavía"} />
                </span>
                <span style={{ textAlign: "center" }}>
                  <Marca estado={f.meli_retorno_en ? "ok" : "pendiente"}
                    titulo={f.meli_retorno_en
                      ? `Escaneado en el centro ${fechaHoraMX(f.meli_retorno_en)}` +
                        (recibio ? ` · recibió ${recibio.nombre}` : "")
                      : "MELI no registra el retorno todavía"} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Vista ──────────────────────────────────────────────────────────────────

export default function DevolucionesPosventa() {
  const [dia, setDia] = useState(() => hoyMX());
  const [bloque, setBloque] = useState("devoluciones");
  const [folios, setFolios] = useState([]);
  const [rutasDev, setRutasDev] = useState({});
  const [torre, setTorre] = useState({});
  const [supervisores, setSupervisores] = useState({});
  const [pruebas, setPruebas] = useState(() => new Map());
  const [abiertas, setAbiertas] = useState(() => new Set());
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [ahora, setAhora] = useState(Date.now());

  // El reloj de la fila de SleepOver: cada minuto alcanza.
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);

    // 1. Los folios a devolver del día. Es lo que define qué rutas aparecen.
    const fol = await sb.from("dev_paquetes_mx")
      .select("id, folio_guia, id_ruta, service_center_id, substatus, incidente, " +
              "meli_retorno_en, meli_personas, aviso1_en, aviso2_en, resultado")
      .eq("dia", dia).eq("requiere", "devolver")
      .order("id_ruta").order("folio_guia");
    if (fol.error) { setError(fol.error.message); setCargando(false); return; }
    const filas = fol.data || [];
    const ids = [...new Set(filas.map((f) => f.id_ruta))];

    if (!ids.length) {
      setFolios([]); setRutasDev({}); setTorre({}); setPruebas(new Map());
      setCargando(false);
      return;
    }

    // 2. El resto, en paralelo. La torre trae varias capturas por ruta: se
    //    pide ordenada por capturado_at desc y se queda con la primera.
    const [dev, tor, sup, pru] = await Promise.all([
      sb.from("dev_rutas_mx")
        .select("id_ruta, sleep_over_en, vence_en, cierre_en, driver_name, service_center_id")
        .in("id_ruta", ids),
      sb.from("rutas_monitoreo_mx")
        .select("id_ruta, driver_name, vehicle_license, service_center_id, status, substatus, capturado_at")
        .in("id_ruta", ids).order("capturado_at", { ascending: false }).limit(ids.length * 12),
      sb.from("vw_pnr_supervisor").select("*"),
      sb.from("dev_pruebas_mx").select("*").in("folio_guia", filas.map((f) => f.folio_guia)),
    ]);

    const malo = dev.error || tor.error || sup.error;
    if (malo) { setError(malo.message); setCargando(false); return; }

    const mDev = {};
    for (const r of dev.data || []) mDev[String(r.id_ruta)] = r;

    const mTor = {};
    for (const r of tor.data || []) {
      const k = String(r.id_ruta);
      if (!mTor[k]) mTor[k] = r;
    }

    const mSup = {};
    for (const s of sup.data || []) if (s.estacion_origen) mSup[s.estacion_origen] = s;

    setFolios(filas);
    setRutasDev(mDev);
    setTorre(mTor);
    setSupervisores(mSup);
    // dev_pruebas_mx puede no existir aún con estas columnas: si falla, las
    // marcas de foto y geo quedan pendientes y el resto de la vista sigue.
    setPruebas(pru.error ? new Map() : marcasDePruebas(pru.data));
    setCargando(false);
  }, [dia]);

  useEffect(() => { cargar(); }, [cargar]);

  // Una fila por ruta: la torre manda en conductor, placa y SC; dev_rutas_mx
  // en SleepOver, plazo y cierre.
  const rutas = useMemo(() => {
    const porRuta = new Map();
    for (const f of folios) {
      const k = String(f.id_ruta);
      if (!porRuta.has(k)) porRuta.set(k, []);
      porRuta.get(k).push(f);
    }
    const lista = [];
    for (const [k, fs] of porRuta) {
      const t = torre[k] || {};
      const d = rutasDev[k] || {};
      lista.push({
        id_ruta: Number(k),
        driver_name: t.driver_name || d.driver_name || fs[0].driver_name || null,
        vehicle_license: t.vehicle_license || null,
        service_center_id: t.service_center_id || d.service_center_id || fs[0].service_center_id || null,
        sleep_over_en: d.sleep_over_en || null,
        vence_en: d.vence_en || null,
        cierre_en: d.cierre_en || null,
        folios: fs,
        estado: estadoRuta(d, fs, ahora),
      });
    }
    // Lo que hay que mirar primero arriba: sin registrar y vencidas, después
    // en ruta, después SleepOver en plazo, y al final las registradas.
    const peso = { sin_registrar: 0, vencida: 0, en_ruta: 1, sleepover: 2, registrada: 3 };
    return lista.sort((a, b) =>
      (peso[a.estado.clave] ?? 9) - (peso[b.estado.clave] ?? 9) ||
      b.folios.length - a.folios.length);
  }, [folios, torre, rutasDev, ahora]);

  const resumen = useMemo(() => {
    const n = (clave) => rutas.filter((r) => r.estado.clave === clave).length;
    return {
      rutas: rutas.length,
      paquetes: folios.length,
      registradas: n("registrada"),
      sinRegistrar: n("sin_registrar") + n("vencida"),
      enRuta: n("en_ruta"),
      sleepover: n("sleepover"),
    };
  }, [rutas, folios]);

  function alternar(id) {
    setAbiertas((prev) => {
      const s = new Set(prev);
      const k = String(id);
      if (s.has(k)) s.delete(k); else s.add(k);
      return s;
    });
  }

  return (
    <div>
      {/* ── Los tres bloques ────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        {BLOQUES.map((b) => {
          const activo = bloque === b.clave;
          return (
            <button key={b.clave} onClick={() => b.activo && setBloque(b.clave)}
              disabled={!b.activo} title={b.activo ? "" : "Todavía no disponible"}
              style={{ flex: 1, textAlign: "left", padding: "11px 14px", borderRadius: 10,
                background: "#fff", cursor: b.activo ? "pointer" : "default",
                border: activo ? `2px solid ${C.navy}` : "1px solid var(--borde)" }}>
              <div style={{ fontSize: 11, color: C.gris, marginBottom: 2 }}>{b.etiqueta}</div>
              {b.clave === "devoluciones" ? (
                <div style={{ fontSize: 20, fontWeight: 800, color: C.navy, lineHeight: 1.1 }}>
                  {resumen.rutas}
                  <span style={{ fontSize: 11.5, fontWeight: 400, color: C.gris, marginLeft: 6 }}>
                    rutas · {resumen.paquetes} paquetes
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 20, fontWeight: 800, color: C.gris, lineHeight: 1.1 }}>—</div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Día y resumen ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.gris }}>Día operativo</span>
        <input type="date" value={dia} max={hoyMX()} onChange={(e) => setDia(e.target.value)}
          style={{ fontSize: 12.5, padding: "5px 9px", borderRadius: 7, border: "1px solid var(--borde)" }} />
        <button onClick={() => setDia(hoyMX())} style={{ fontSize: 11.5, padding: "5px 10px" }}>Hoy</button>

        <span style={{ width: 1, height: 20, background: "var(--borde)", margin: "0 4px" }} />

        <Pill color={C.verde} tinte={C.verdeTenue}><span>✓</span>{resumen.registradas} registradas</Pill>
        <Pill color={C.ladrillo} tinte={C.ladrilloTenue}><span>!</span>{resumen.sinRegistrar} sin registrar</Pill>
        {resumen.enRuta > 0 && <Pill color={C.gris} tinte={C.grisTenue}><span>→</span>{resumen.enRuta} en ruta</Pill>}
        {resumen.sleepover > 0 && <Pill color={C.naranja} tinte={C.naranjaTenue}><span>☾</span>{resumen.sleepover} sleepover</Pill>}

        <button onClick={cargar} disabled={cargando}
          style={{ marginLeft: "auto", fontSize: 11.5, padding: "5px 11px" }}>
          {cargando ? "Cargando…" : "Actualizar"}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 9,
          background: C.ladrilloTenue, border: `1px solid ${C.ladrillo}33`,
          color: C.ladrillo, fontSize: 12.5 }}>{error}</div>
      )}

      {/* ── La tabla ────────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--borde)", borderRadius: 12, background: "#fff",
        overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: GRID_RUTA, gap: 10,
          padding: "8px 12px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
          textTransform: "uppercase", color: C.gris, background: C.navyTenue }}>
          <span></span><span>Ruta</span><span>Conductor</span><span>SC</span>
          <span>Supervisor</span><span style={{ textAlign: "right" }}>Estado</span>
        </div>

        {cargando ? (
          <div style={{ padding: 16, fontSize: 12.5, color: C.gris }}>Cargando el día…</div>
        ) : !rutas.length ? (
          <div style={{ padding: 16, fontSize: 12.5, color: C.gris }}>
            Ninguna ruta con paquetes a devolver el {dia}.
          </div>
        ) : rutas.map((r) => (
          <FilaRuta key={r.id_ruta} r={r} folios={r.folios}
            sup={supervisores[r.service_center_id]}
            pruebas={pruebas}
            abierta={abiertas.has(String(r.id_ruta))}
            alternar={() => alternar(r.id_ruta)}
            ahora={ahora} />
        ))}
      </div>

      <div style={{ fontSize: 10.5, color: C.gris, lineHeight: 1.6, padding: "8px 2px 0" }}>
        La fila se marca <strong>registrada</strong> cuando MELI escaneó todos los
        paquetes en el centro. Foto y georreferencia las manda el conductor por
        WhatsApp y se ven al desplegar; todavía no están conectadas.
      </div>
    </div>
  );
}
