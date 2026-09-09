import { useState, useEffect, useRef, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { puedeActuar } from "../shared/permisos.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";

// ═══════════════════════════════════════════════════════════════════════════
// POLÍGONOS · zonas de riesgo y monitoreo de rutas
//
// DOS SUBPESTAÑAS PORQUE SON DOS TRABAJOS
//   DIBUJO — el analista traza las zonas una vez y las administra: agrega,
//   edita, elimina. Es trabajo de configuración, se hace de a ratos.
//
//   MONITOREO — las rutas del día con entregas dentro de esas zonas. Es
//   trabajo de operación, se mira todos los días.
//
// CÓMO SE CONECTAN
//   Cuando una ruta arranca, seg-paradas.cjs captura sus 80 o 90 paradas con
//   la coordenada de cada domicilio y marca las que caen dentro de una zona
//   activa. El cruce se resuelve al capturar, no al mirar la pantalla.
//
//   Por eso al guardar una zona nueva hay que recruzar: las rutas que ya
//   arrancaron tienen sus paradas guardadas sin saber de la zona recién
//   dibujada. La pantalla lo hace sola después de cada cambio.
//
// LEAFLET DIRECTO, SIN REACT-LEAFLET
//   El wrapper de React obliga a envolver cada control de dibujo y pelea con
//   el ciclo de vida de leaflet-draw. Montar el mapa en un useEffect y
//   limpiarlo al desmontar es menos código y no esconde nada.
//
// LOS CÍRCULOS SE GUARDAN COMO POLÍGONO
//   PostGIS no tiene un tipo círculo. Un círculo dibujado se convierte en un
//   polígono de 64 lados, que a escala de barrio es indistinguible del círculo
//   y se puede consultar con st_intersects como cualquier otra zona.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1B2A4A",
  naranja: "#E8632A",
  ladrillo: "#B54634",
  gris: "#6B7A90",
  verde: "#1a7f5a",
};

// El nivel es la severidad y decide el color; el tipo es la naturaleza del
// problema y lo escribe el analista. Separarlos permite priorizar una alerta
// sin importar el motivo.
const NIVELES = [
  { clave: "alto",        etiqueta: "Alto",        color: "#B54634" },
  { clave: "medio",       etiqueta: "Medio",       color: "#E8632A" },
  { clave: "observacion", etiqueta: "Observación", color: "#6B7A90" },
];
const COLOR_NIVEL = Object.fromEntries(NIVELES.map((n) => [n.clave, n.color]));

// Sugerencias, no una lista cerrada: el analista escribe lo que necesite.
const TIPOS = ["Peligroso", "Difícil acceso", "Sin estacionamiento",
               "Calle cerrada", "Zona con reclamos"];

const CENTRO_MX = [23.6345, -102.5528];

function cuando(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// Un círculo a polígono de 64 lados. El radio va en metros y la corrección por
// latitud es necesaria: sin ella un círculo de 300 m sale ovalado, y más cuanto
// más al norte.
function circuloAPoligono(centro, radioM, lados = 64) {
  const puntos = [];
  const latR = (centro.lat * Math.PI) / 180;
  const dLat = radioM / 111320;
  const dLng = radioM / (111320 * Math.cos(latR));
  for (let i = 0; i < lados; i++) {
    const a = (i / lados) * 2 * Math.PI;
    puntos.push([
      centro.lng + dLng * Math.cos(a),
      centro.lat + dLat * Math.sin(a),
    ]);
  }
  puntos.push(puntos[0]);
  return puntos;
}

// De una capa de Leaflet al WKT que entiende PostGIS. Se usa WKT y no GeoJSON
// porque st_geogfromtext acepta el texto directo sin conversión intermedia.
function capaAWkt(capa) {
  let anillo;
  if (capa instanceof L.Circle) {
    anillo = circuloAPoligono(capa.getLatLng(), capa.getRadius());
  } else {
    const puntos = capa.getLatLngs()[0] || [];
    anillo = puntos.map((p) => [p.lng, p.lat]);
    if (anillo.length) anillo.push(anillo[0]);
  }
  if (anillo.length < 4) return null;
  return `POLYGON((${anillo.map(([x, y]) => `${x} ${y}`).join(", ")}))`;
}

// ── Subpestaña de dibujo ───────────────────────────────────────────────────
function Dibujo({ puede, onCambio }) {
  const cajaMapa = useRef(null);
  const mapa = useRef(null);
  const grupo = useRef(null);
  const [zonas, setZonas] = useState([]);
  const [error, setError] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [nueva, setNueva] = useState(null);
  const [form, setForm] = useState({ nombre: "", nivel: "alto", tipo: "", nota: "", scs: "" });
  const { analista } = useAuth();

  const cargar = useCallback(async () => {
    const { data, error: e } = await sb.rpc("fn_seg_zonas");
    if (e) { setError(e.message); return; }
    setZonas(data || []);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // El mapa se monta una vez. Las zonas se repintan en otro efecto cuando
  // cambian, así que redibujarlas no obliga a recrear el mapa.
  useEffect(() => {
    if (mapa.current || !cajaMapa.current) return;

    const m = L.map(cajaMapa.current, { center: CENTRO_MX, zoom: 5 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(m);

    const g = new L.FeatureGroup().addTo(m);
    grupo.current = g;

    if (puede) {
      const control = new L.Control.Draw({
        position: "topright",
        draw: {
          polygon: { allowIntersection: false, showArea: true,
                     shapeOptions: { color: C.ladrillo, weight: 2 } },
          circle: { shapeOptions: { color: C.ladrillo, weight: 2 } },
          // Lo demás no: una zona es un área, y dejar dibujar líneas o puntos
          // solo produce geometrías que el cruce no puede usar.
          rectangle: false, marker: false, circlemarker: false, polyline: false,
        },
        edit: false,
      });
      m.addControl(control);

      m.on(L.Draw.Event.CREATED, (ev) => {
        // La forma recién dibujada se muestra pero NO se guarda todavía: sin
        // nombre y nivel una zona no sirve de nada, así que primero el
        // formulario.
        g.addLayer(ev.layer);
        const wkt = capaAWkt(ev.layer);
        if (!wkt) { g.removeLayer(ev.layer); setError("La forma quedó incompleta."); return; }
        setNueva({ wkt, capa: ev.layer });
        setForm({ nombre: "", nivel: "alto", tipo: "", nota: "", scs: "" });
      });
    }

    mapa.current = m;

    // Leaflet no se lleva bien con el montaje de React: si el contenedor
    // cambia de tamaño después de crear el mapa, los tiles quedan cortados.
    setTimeout(() => m.invalidateSize(), 200);

    return () => { m.remove(); mapa.current = null; };
  }, [puede]);

  // Repinta las zonas guardadas. Se limpia y se vuelve a dibujar todo: son
  // decenas de polígonos, no miles, y comparar cuál cambió costaría más que
  // rehacerlos.
  useEffect(() => {
    const g = grupo.current;
    if (!g) return;
    g.clearLayers();
    if (nueva?.capa) g.addLayer(nueva.capa);

    for (const z of zonas) {
      if (!z.geojson) continue;
      L.geoJSON(JSON.parse(z.geojson), {
        style: { color: COLOR_NIVEL[z.nivel] || C.gris, weight: 2, fillOpacity: 0.18 },
      }).bindTooltip(
        `<strong>${z.nombre}</strong><br>${z.tipo || "sin tipo"} · nivel ${z.nivel}`
        + (z.paradas_30d ? `<br>${z.paradas_30d} paradas en 30 días` : ""),
        { sticky: true },
      ).addTo(g);
    }

    // Encuadra en lo dibujado. Sin esto el mapa arranca en todo México y hay
    // que buscar las zonas a mano cada vez que se abre la pestaña.
    if (zonas.length && mapa.current) {
      try {
        const b = g.getBounds();
        if (b.isValid()) mapa.current.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
      } catch {}
    }
  }, [zonas, nueva]);

  async function guardar() {
    if (!nueva || !form.nombre.trim()) { setError("Ponle un nombre a la zona."); return; }
    setGuardando(true);
    setError(null);
    const { error: e } = await sb.rpc("fn_seg_zona_guardar", {
      p_id: null,
      p_nombre: form.nombre.trim(),
      p_nivel: form.nivel,
      p_tipo: form.tipo.trim() || null,
      p_nota: form.nota.trim() || null,
      p_wkt: nueva.wkt,
      p_scs: form.scs.trim()
        ? form.scs.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
        : null,
      p_analista_id: analista?.id || null,
    });
    setGuardando(false);
    if (e) { setError("No se pudo guardar: " + e.message); return; }
    setNueva(null);
    await cargar();
    onCambio?.();
  }

  async function borrar(z) {
    if (!window.confirm(`¿Eliminar la zona "${z.nombre}"?`)) return;
    const { error: e } = await sb.rpc("fn_seg_zona_borrar", { p_id: z.id });
    if (e) { setError("No se pudo eliminar: " + e.message); return; }
    await cargar();
    onCambio?.();
  }

  async function cambiarNivel(z, nivel) {
    const { error: e } = await sb.rpc("fn_seg_zona_guardar", {
      p_id: z.id, p_nombre: z.nombre, p_nivel: nivel, p_tipo: z.tipo,
      p_nota: z.nota, p_wkt: null, p_scs: z.service_centers,
      p_analista_id: analista?.id || null,
    });
    if (e) { setError("No se pudo cambiar: " + e.message); return; }
    await cargar();
    onCambio?.();
  }

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 10 }}>{error}</div>
      )}

      {!puede && (
        <div style={{ fontSize: 12, color: C.gris, marginBottom: 10 }}>
          Solo puedes mirar: dibujar y editar zonas requiere permisos de analista.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap",
        alignItems: "flex-start" }}>

        <div style={{ flex: "1 1 560px", minWidth: 320 }}>
          <div ref={cajaMapa}
            style={{ height: 520, borderRadius: 12, border: "1px solid var(--borde)",
              overflow: "hidden" }} />
          {puede && (
            <div style={{ fontSize: 11, color: C.gris, marginTop: 6 }}>
              Usa las herramientas de la derecha del mapa para trazar un polígono
              o un círculo. Al terminar se pide el nombre y el nivel.
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 300px", minWidth: 280 }}>
          {/* El formulario aparece solo cuando hay una forma recién dibujada.
              Ocuparle el espacio permanentemente confunde: parece que hay algo
              que llenar cuando no lo hay. */}
          {nueva && (
            <div style={{ border: `1px solid ${C.ladrillo}`, borderRadius: 12,
              padding: "12px 14px", background: "#FFF7F3", marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy,
                marginBottom: 8 }}>
                Nueva zona
              </div>

              <input value={form.nombre} autoFocus
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                placeholder="Nombre · ej: Colonia Libertad poniente"
                style={{ width: "100%", fontSize: 12.5, padding: "7px 9px",
                  borderRadius: 8, border: "1px solid var(--borde)",
                  boxSizing: "border-box", marginBottom: 7 }} />

              <div style={{ display: "flex", gap: 5, marginBottom: 7 }}>
                {NIVELES.map((n) => (
                  <button key={n.clave} onClick={() => setForm({ ...form, nivel: n.clave })}
                    style={{ flex: 1, fontSize: 11.5, padding: "5px 4px", borderRadius: 7,
                      fontWeight: form.nivel === n.clave ? 700 : 400,
                      color: form.nivel === n.clave ? "#fff" : n.color,
                      background: form.nivel === n.clave ? n.color : "#fff",
                      border: `1px solid ${n.color}` }}>
                    {n.etiqueta}
                  </button>
                ))}
              </div>

              <input value={form.tipo} list="tipos-zona"
                onChange={(e) => setForm({ ...form, tipo: e.target.value })}
                placeholder="Tipo · peligroso, sin estacionamiento…"
                style={{ width: "100%", fontSize: 12.5, padding: "7px 9px",
                  borderRadius: 8, border: "1px solid var(--borde)",
                  boxSizing: "border-box", marginBottom: 7 }} />
              <datalist id="tipos-zona">
                {TIPOS.map((t) => <option key={t} value={t} />)}
              </datalist>

              <input value={form.scs}
                onChange={(e) => setForm({ ...form, scs: e.target.value })}
                placeholder="Centros · SMX8, SQR1 (vacío = todos)"
                style={{ width: "100%", fontSize: 12.5, padding: "7px 9px",
                  borderRadius: 8, border: "1px solid var(--borde)",
                  boxSizing: "border-box", marginBottom: 7 }} />

              <textarea value={form.nota} rows={2}
                onChange={(e) => setForm({ ...form, nota: e.target.value })}
                placeholder="Nota para el chofer y el analista"
                style={{ width: "100%", fontSize: 12.5, padding: "7px 9px",
                  borderRadius: 8, border: "1px solid var(--borde)",
                  fontFamily: "inherit", resize: "vertical",
                  boxSizing: "border-box", marginBottom: 8 }} />

              <div style={{ display: "flex", gap: 7 }}>
                <button onClick={guardar} disabled={guardando || !form.nombre.trim()}
                  className="btn-navy"
                  style={{ fontSize: 12, fontWeight: 600, padding: "7px 14px",
                    borderRadius: 8 }}>
                  {guardando ? "Guardando…" : "Guardar zona"}
                </button>
                <button onClick={() => setNueva(null)}
                  style={{ fontSize: 12, padding: "7px 12px", borderRadius: 8 }}>
                  Descartar
                </button>
              </div>
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
            textTransform: "uppercase", color: C.gris, marginBottom: 7 }}>
            Zonas dibujadas ({zonas.length})
          </div>

          {zonas.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.gris, padding: "16px 0",
              textAlign: "center", border: "1px dashed var(--borde)",
              borderRadius: 11 }}>
              Ninguna zona todavía.
            </div>
          ) : (
            <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
              background: "#fff", overflow: "hidden" }}>
              {zonas.map((z) => (
                <div key={z.id} style={{ padding: "9px 12px",
                  borderBottom: "1px solid var(--borde)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 7,
                    flexWrap: "wrap" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2,
                      background: COLOR_NIVEL[z.nivel] || C.gris, flexShrink: 0 }} />
                    <strong style={{ fontSize: 12.5 }}>{z.nombre}</strong>
                    <span style={{ fontSize: 11, color: C.gris }}>
                      {z.tipo || "sin tipo"}
                    </span>
                    {/* Cuántas paradas cayeron acá en 30 días: es lo que dice
                        si la zona importa o si se dibujó sobre un descampado. */}
                    {z.paradas_30d > 0 && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: C.navy }}>
                        {z.paradas_30d} paradas · 30 d
                      </span>
                    )}
                  </div>

                  {z.nota && (
                    <div style={{ fontSize: 11, color: "var(--texto-suave)",
                      marginTop: 3, lineHeight: 1.4 }}>{z.nota}</div>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: 6,
                    marginTop: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10.5, color: C.gris }}>
                      {(z.service_centers || []).length
                        ? (z.service_centers || []).join(", ")
                        : "todos los centros"}
                      {" · "}{cuando(z.creada_at)}
                    </span>
                    {puede && (
                      <>
                        <select value={z.nivel}
                          onChange={(e) => cambiarNivel(z, e.target.value)}
                          style={{ fontSize: 10.5, padding: "2px 5px", borderRadius: 6,
                            border: "1px solid var(--borde)", marginLeft: "auto" }}>
                          {NIVELES.map((n) => (
                            <option key={n.clave} value={n.clave}>{n.etiqueta}</option>
                          ))}
                        </select>
                        <button onClick={() => borrar(z)}
                          style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 6,
                            color: C.ladrillo }}>
                          Eliminar
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Subpestaña de monitoreo ────────────────────────────────────────────────
function Monitoreo({ refresco }) {
  const [dia, setDia] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }));
  const [rutas, setRutas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState(null);
  const cajaMapa = useRef(null);
  const mapa = useRef(null);
  const capas = useRef(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error: e } = await sb.from("vw_seg_rutas_en_zona")
      .select("*").eq("fecha", dia).order("paradas_en_zona", { ascending: false });
    setCargando(false);
    if (e) { setError(e.message); return; }
    setRutas(data || []);
  }, [dia]);

  useEffect(() => { cargar(); }, [cargar, refresco]);

  // Una ruta a la vez, como se pidió: mostrar las 22 juntas en el mapa deja un
  // borrón de puntos donde no se distingue de quién es cada uno.
  useEffect(() => {
    if (!sel || !cajaMapa.current) return;

    if (!mapa.current) {
      const m = L.map(cajaMapa.current, { center: CENTRO_MX, zoom: 5 });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap",
      }).addTo(m);
      capas.current = new L.FeatureGroup().addTo(m);
      mapa.current = m;
      setTimeout(() => m.invalidateSize(), 200);
    }

    const g = capas.current;
    g.clearLayers();

    for (const p of sel.paradas || []) {
      L.circleMarker([p.lat, p.lng], {
        radius: 7, color: "#fff", weight: 2, fillColor: C.ladrillo, fillOpacity: 0.95,
      }).bindTooltip(
        `<strong>Parada ${p.secuencia}</strong><br>${p.zona}<br>envío ${p.envio_id}`,
        { sticky: true },
      ).addTo(g);
    }

    try {
      const b = g.getBounds();
      if (b.isValid()) mapa.current.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
    } catch {}
  }, [sel]);

  useEffect(() => () => { if (mapa.current) { mapa.current.remove(); mapa.current = null; } }, []);

  const total = rutas.reduce((s, r) => s + Number(r.paradas_en_zona || 0), 0);

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 10 }}>{error}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12,
        flexWrap: "wrap", marginBottom: 12 }}>
        <input type="date" value={dia} onChange={(e) => { setSel(null); setDia(e.target.value); }}
          style={{ fontSize: 12.5, padding: "6px 9px", borderRadius: 8,
            border: "1px solid var(--borde)" }} />
        <span style={{ fontSize: 12, color: C.gris }}>
          {cargando ? "cargando…"
            : `${rutas.length} ruta(s) con ${total} entrega(s) en zona`}
        </span>
        <button onClick={cargar} style={{ fontSize: 11.5, padding: "5px 10px",
          borderRadius: 7 }}>Actualizar</button>
      </div>

      {rutas.length === 0 && !cargando ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "24px 0",
          textAlign: "center", border: "1px dashed var(--borde)", borderRadius: 12 }}>
          Ninguna ruta de este día tiene entregas dentro de una zona.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap",
          alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 340px", minWidth: 300, border: "1px solid var(--borde)",
            borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            {rutas.map((r) => {
              const activa = sel?.ruta_id === r.ruta_id;
              return (
                <button key={r.ruta_id} onClick={() => setSel(activa ? null : r)}
                  style={{ width: "100%", textAlign: "left", border: "none",
                    borderBottom: "1px solid var(--borde)", padding: "9px 12px",
                    background: activa ? "#F7F9FC" : "#fff", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                    flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 12.5, color: C.navy,
                      fontVariantNumeric: "tabular-nums" }}>{r.ruta_id}</strong>
                    <span style={{ fontSize: 11.5, fontWeight: 700 }}>
                      {r.sc_code || "—"}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700,
                      color: r.en_nivel_alto > 0 ? C.ladrillo : C.naranja }}>
                      {r.paradas_en_zona} en zona
                    </span>
                    <span style={{ fontSize: 11, color: C.gris }}>
                      de {r.paradas_total}
                    </span>
                    {r.placa && (
                      <span style={{ fontSize: 10.5, color: C.gris,
                        marginLeft: "auto" }}>{r.placa}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--texto-suave)", marginTop: 3 }}>
                    {(r.zonas || []).map((z) => z.nombre).join(" · ") || "—"}
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ flex: "1 1 460px", minWidth: 320 }}>
            {sel ? (
              <>
                <div ref={cajaMapa}
                  style={{ height: 420, borderRadius: 12,
                    border: "1px solid var(--borde)", overflow: "hidden" }} />
                <div style={{ marginTop: 8, border: "1px solid var(--borde)",
                  borderRadius: 11, background: "#fff", padding: "4px 10px",
                  maxHeight: 200, overflowY: "auto" }}>
                  {(sel.paradas || []).map((p) => (
                    <div key={p.envio_id} style={{ display: "flex", gap: 9,
                      alignItems: "baseline", padding: "5px 2px", fontSize: 12,
                      borderBottom: "1px solid var(--borde)" }}>
                      <span style={{ fontWeight: 700, minWidth: 30,
                        fontVariantNumeric: "tabular-nums" }}>{p.secuencia}</span>
                      <span style={{ color: C.ladrillo, minWidth: 140 }}>{p.zona}</span>
                      <span style={{ color: C.gris, flex: 1 }}>envío {p.envio_id}</span>
                      <span style={{ fontSize: 10.5, color: C.gris }}>{p.estado}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: C.gris, padding: "40px 0",
                textAlign: "center", border: "1px dashed var(--borde)",
                borderRadius: 12 }}>
                Elige una ruta para ver sus entregas en zona.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Poligonos() {
  const { analista } = useAuth();
  const puede = puedeActuar(analista);
  const [vista, setVista] = useState("dibujo");
  // Al guardar o borrar una zona el monitoreo tiene que releerse: el cruce se
  // recalcula en la base y las rutas del día cambian de golpe.
  const [refresco, setRefresco] = useState(0);

  return (
    <div style={{ padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8,
        marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: C.navy, margin: 0 }}>
          Polígonos
        </h2>
        {[["dibujo", "Dibujo"], ["monitoreo", "Monitoreo"]].map(([clave, etiqueta]) => (
          <button key={clave} onClick={() => setVista(clave)}
            style={{ fontSize: 12.5, padding: "5px 13px", borderRadius: 8,
              fontWeight: vista === clave ? 600 : 400,
              border: "1px solid " + (vista === clave ? C.navy : "var(--borde)"),
              background: vista === clave ? C.navy : "#fff",
              color: vista === clave ? "#fff" : "var(--texto)" }}>
            {etiqueta}
          </button>
        ))}
      </div>

      {vista === "dibujo"
        ? <Dibujo puede={puede} onCambio={() => setRefresco((n) => n + 1)} />
        : <Monitoreo refresco={refresco} />}
    </div>
  );
}
