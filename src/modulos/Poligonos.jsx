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

// Cuántas camionetas están a menos de un kilómetro de una entrega en zona.
//   Alimenta el badge de la pestaña en el topbar. Se cuenta cada minuto y no
//   por Realtime porque lo que cambia no es una fila: es la distancia, que se
//   recalcula sola cuando el scraper guarda una posición nueva.
export function useSegAlertas() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let vivo = true;
    const contar = async () => {
      const { count } = await sb.from("vw_seg_alertas")
        .select("ruta_id", { count: "exact", head: true });
      if (vivo) setN(count || 0);
    };
    contar();
    const t = setInterval(() => { if (!document.hidden) contar(); }, 60000);
    return () => { vivo = false; clearInterval(t); };
  }, []);
  return n;
}

// Buscador de lugares contra Nominatim, el geocodificador de OpenStreetMap.
//   Sin esto había que arrastrar el mapa desde todo México hasta el barrio, y
//   con 12 centros repartidos en el país eso son varios minutos por zona.
//
//   Gratis y sin clave, pero pide identificarse y limita a una consulta por
//   segundo, así que se dispara al enviar el formulario y no mientras se
//   escribe. Con búsqueda incremental se pasaría el límite en dos palabras.
async function buscarLugar(texto) {
  const url = "https://nominatim.openstreetmap.org/search"
    + `?format=json&limit=5&countrycodes=mx&q=${encodeURIComponent(texto)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "es" } });
  if (!r.ok) throw new Error("el buscador no respondió");
  return (await r.json()).map((x) => ({
    nombre: x.display_name,
    lat: Number(x.lat),
    lng: Number(x.lon),
  }));
}

// El nombre del lugar de unas coordenadas. Se pide UNA vez, al guardar la
// zona, y se queda en la nota: así el listado no depende de un servicio
// externo cada vez que alguien abre la pestaña.
async function nombreDelLugar(lat, lng) {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/reverse"
      + `?format=json&zoom=14&lat=${lat}&lon=${lng}`,
      { headers: { "Accept-Language": "es" } });
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.address || {};
    // De lo más específico a lo más general: colonia, pueblo, municipio.
    return [a.suburb || a.neighbourhood || a.village || a.town || a.city,
            a.state].filter(Boolean).join(", ") || null;
  } catch { return null; }
}

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
  const [busca, setBusca] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [hallados, setHallados] = useState([]);
  // Se recuerda dónde estaba el mapa para no devolverlo a todo México cada vez
  // que el listado de zonas cambia. Ver el efecto de repintado.
  const encuadrado = useRef(false);
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
          // Sin allowIntersection: false. Con esa validación leaflet-draw
          // cerraba el polígono al tercer vértice y no dejaba pasar de un
          // triángulo. Un polígono que se cruza a sí mismo es raro pero no
          // rompe nada: PostGIS lo acepta y el cruce sigue funcionando.
          polygon: { showArea: true,
                     shapeOptions: { color: C.ladrillo, weight: 2 } },
          circle: { shapeOptions: { color: C.ladrillo, weight: 2 } },
          // El rectángulo queda fuera: en esta versión de leaflet-draw se
          // dibuja arrastrando y no responde, dejaba una sola línea en vez de
          // la caja. Un botón que no hace nada es peor que no tenerlo, y entre
          // el polígono libre y el círculo está cubierto todo el uso real.
          rectangle: false,
          // Líneas y puntos tampoco: una zona es un área, y una geometría sin
          // superficie no puede contener una parada.
          marker: false, circlemarker: false, polyline: false,
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

    // Encuadra UNA sola vez, al abrir la pestaña.
    //   Antes reencuadraba en cada repintado, y como el repintado se dispara al
    //   guardar, borrar o descartar una zona, el mapa saltaba de vuelta al
    //   conjunto completo — normalmente Ciudad de México, donde están las
    //   primeras zonas. Si te equivocabas dibujando en Tabasco, el descarte te
    //   mandaba a 700 km de donde estabas trabajando.
    if (!encuadrado.current && zonas.length && mapa.current) {
      try {
        const b = g.getBounds();
        if (b.isValid()) {
          mapa.current.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
          encuadrado.current = true;
        }
      } catch {}
    }
  }, [zonas, nueva]);

  async function guardar() {
    if (!nueva || !form.nombre.trim()) { setError("Ponle un nombre a la zona."); return; }
    setGuardando(true);
    setError(null);

    // Dónde queda la zona, resuelto al guardar y no al mostrarla.
    //   El nombre del lugar sale de Nominatim y las coordenadas del centro de
    //   la forma. Van dentro de la nota porque es texto libre y no obliga a
    //   otra columna, y sobre todo porque así el listado nunca depende de que
    //   un servicio externo responda.
    let ubic = "";
    try {
      const c = nueva.capa.getBounds().getCenter();
      const lugar = await nombreDelLugar(c.lat, c.lng);
      ubic = `${lugar ? lugar + " · " : ""}${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
    } catch {}

    const { error: e } = await sb.rpc("fn_seg_zona_guardar", {
      p_id: null,
      p_nombre: form.nombre.trim(),
      p_nivel: form.nivel,
      p_tipo: form.tipo.trim() || null,
      p_nota: [ubic, form.nota.trim()].filter(Boolean).join(" — ") || null,
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
          {/* Buscador de lugares. Escribir "Huimanguillo" y llegar es mucho más
              rápido que arrastrar el mapa por medio país. */}
          <form onSubmit={async (e) => {
            e.preventDefault();
            if (!busca.trim()) return;
            setBuscando(true); setError(null); setHallados([]);
            try {
              const res = await buscarLugar(busca.trim());
              if (!res.length) { setError(`No encontré "${busca.trim()}".`); }
              else if (res.length === 1) {
                mapa.current?.setView([res[0].lat, res[0].lng], 15);
              } else setHallados(res);
            } catch (err) { setError(err.message); }
            setBuscando(false);
          }} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input value={busca} onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar lugar · Huimanguillo, Veracruz, Nezahualcóyotl…"
              style={{ flex: 1, fontSize: 12.5, padding: "7px 10px", borderRadius: 8,
                border: "1px solid var(--borde)" }} />
            <button type="submit" disabled={buscando || !busca.trim()}
              style={{ fontSize: 12, padding: "7px 13px", borderRadius: 8 }}>
              {buscando ? "…" : "Ir"}
            </button>
          </form>

          {/* Varios resultados: se elige, no se adivina. "Veracruz" es un
              estado, una ciudad y varias colonias. */}
          {hallados.length > 0 && (
            <div style={{ border: "1px solid var(--borde)", borderRadius: 9,
              background: "#fff", marginBottom: 8, overflow: "hidden" }}>
              {hallados.map((h, i) => (
                <button key={i} onClick={() => {
                  mapa.current?.setView([h.lat, h.lng], 15);
                  setHallados([]);
                }} style={{ width: "100%", textAlign: "left", border: "none",
                  borderBottom: "1px solid var(--borde)", padding: "6px 10px",
                  fontSize: 11.5, background: "#fff", cursor: "pointer" }}>
                  {h.nombre}
                </button>
              ))}
            </div>
          )}

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
            /* Alto máximo con scroll propio: con una docena de zonas el listado
               empujaba el contenido más allá de la pantalla, y como Leaflet se
               queda la rueda del mouse no había forma de bajar. */
            <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
              background: "#fff", overflow: "hidden auto", maxHeight: 520 }}>
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

  const cargar = useCallback(async () => {
    setCargando(true);
    // Las rutas y las alertas en un viaje: la alerta es "esta camioneta está
    // llegando a una zona AHORA", y sin ella la lista solo dice qué rutas
    // tienen entregas marcadas, sin decir cuál es urgente.
    const [r, a] = await Promise.all([
      sb.from("vw_seg_rutas_en_zona")
        .select("*").eq("fecha", dia).order("paradas_en_zona", { ascending: false }),
      sb.from("vw_seg_alertas").select("*"),
    ]);
    setCargando(false);
    if (r.error) { setError(r.error.message); return; }
    const alertas = new Map((a.data || []).map((x) => [String(x.ruta_id), x]));
    setRutas((r.data || []).map((x) => ({
      ...x, alerta: alertas.get(String(x.ruta_id)) || null,
    })));
  }, [dia]);

  useEffect(() => {
    cargar();
    // Las posiciones se guardan cada 5 minutos, así que releer cada minuto
    // mantiene la distancia razonablemente al día sin castigar la base.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 60000);
    return () => clearInterval(t);
  }, [cargar, refresco]);

  // Una ruta a la vez, como se pidió: mostrar las 22 juntas en el mapa deja un
  // borrón de puntos donde no se distingue de quién es cada uno.
  //
  // EL MAPA SE DESTRUYE Y SE VUELVE A CREAR CON CADA RUTA.
  //   Antes se creaba una sola vez y se guardaba en un ref. Pero al cambiar a
  //   la pestaña de Dibujo el contenedor se desmonta, y al volver Leaflet
  //   seguía apuntando a un div que ya no existe: el mapa quedaba en blanco y
  //   solo se arreglaba recargando la página.
  //
  //   Recrearlo cuesta unos milisegundos y elimina la clase entera de errores
  //   de sincronización entre el ciclo de vida de React y el de Leaflet.
  useEffect(() => {
    if (!sel || !cajaMapa.current) return;

    const m = L.map(cajaMapa.current, { center: CENTRO_MX, zoom: 5 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(m);
    const g = new L.FeatureGroup().addTo(m);
    mapa.current = m;

    // Verde las entregadas, ladrillo las que faltan.
    //   Sobre el mapa se ve el avance de la ruta de un vistazo: qué tramo de
    //   la zona ya pasó y cuál le queda. Sin eso, 34 puntos rojos no dicen si
    //   el riesgo ya ocurrió o está por venir.
    for (const p of sel.paradas || []) {
      const hecha = p.estado === "complete" || p.estado === "delivered";
      L.circleMarker([p.lat, p.lng], {
        radius: hecha ? 6 : 7, color: "#fff", weight: 2,
        fillColor: hecha ? C.verde : C.ladrillo,
        fillOpacity: hecha ? 0.75 : 0.95,
      }).bindTooltip(
        `<strong>Parada ${p.secuencia}</strong> · ${hecha ? "entregada" : "pendiente"}`
        + `<br>${p.zona}<br>envío ${p.envio_id}`,
        { sticky: true },
      ).addTo(g);
    }

    // La camioneta, con su hora de medición.
    //   Va en azul y más grande que las paradas: es lo único móvil del mapa y
    //   tiene que distinguirse de un vistazo entre 34 puntos rojos.
    //
    //   La hora importa tanto como la posición: MELI a veces reporta una
    //   medición de hace rato, y un pin sin hora se lee como "está ahí ahora"
    //   cuando puede ser de hace media hora.
    if (sel.veh_lat != null && sel.veh_lng != null) {
      const edad = sel.veh_medido_en
        ? Math.round((Date.now() - new Date(sel.veh_medido_en)) / 60000)
        : null;
      // Un icono de camioneta y no un círculo: entre 34 puntos redondos, otro
      // punto redondo más grande no se lee como "el vehículo". La silueta sí.
      L.marker([sel.veh_lat, sel.veh_lng], {
        icon: L.divIcon({
          className: "",
          html: `<div style="width:30px;height:30px;border-radius:50%;`
              + `background:${C.navy};border:2.5px solid #fff;`
              + `box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;`
              + `align-items:center;justify-content:center;color:#fff;`
              + `font-size:17px;line-height:1">&#128666;</div>`,
          iconSize: [30, 30], iconAnchor: [15, 15],
        }),
        zIndexOffset: 1000,
      }).bindTooltip(
        `<strong>Camioneta ${sel.placa || ""}</strong><br>`
        + (edad == null ? "sin hora de medición"
           : edad < 1 ? "posición de hace menos de un minuto"
           : `posición de hace ${edad} min`)
        + (sel.veh_metros_a_zona != null
           ? `<br>a ${sel.veh_metros_a_zona} m de la zona más cercana` : ""),
        { sticky: true, direction: "top" },
      ).addTo(g).openTooltip();
    }

    try {
      const b = g.getBounds();
      if (b.isValid()) m.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
    } catch {}
    setTimeout(() => m.invalidateSize(), 150);

    return () => { m.remove(); mapa.current = null; };
  }, [sel]);

  const total = rutas.reduce((s, r) => s + Number(r.paradas_en_zona || 0), 0);
  const conAlerta = rutas.filter((r) => r.alerta).length;

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
        {conAlerta > 0 && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "#fff",
            background: C.ladrillo, borderRadius: 10, padding: "2px 9px" }}>
            {conAlerta} llegando a una zona
          </span>
        )}
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
            {/* Las que tienen alerta primero: una camioneta a 24 metros de una
                zona no puede estar debajo de otra que tiene más paradas
                marcadas pero está a 20 km. */}
            {[...rutas].sort((a, b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0)
              || (a.alerta?.metros ?? 9e9) - (b.alerta?.metros ?? 9e9)).map((r) => {
              const activa = sel?.ruta_id === r.ruta_id;
              return (
                <button key={r.ruta_id} onClick={() => setSel(activa ? null : r)}
                  style={{ width: "100%", textAlign: "left", border: "none",
                    borderBottom: "1px solid var(--borde)", padding: "9px 12px",
                    background: activa ? "#F7F9FC" : "#fff", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                    flexWrap: "wrap" }}>
                    {/* El globo: rojo si la zona más cercana es de nivel alto,
                        naranja si no. Solo aparece con la camioneta a menos de
                        un kilómetro y con posición medida hace poco. */}
                    {r.alerta && (
                      <span title={`A ${r.alerta.metros} m de ${r.alerta.zonas}`}
                        style={{ width: 9, height: 9, borderRadius: "50%",
                          flexShrink: 0,
                          background: r.alerta.tiene_alto ? C.ladrillo : C.naranja }} />
                    )}
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
                    {/* Qué tan cerca está la camioneta AHORA. Es el dato que
                        decide si hay que llamar: una ruta con 34 entregas en
                        zona pero el vehículo a 20 km todavía no es urgente. */}
                    {r.alerta && (
                      <span style={{ fontSize: 11.5, fontWeight: 700,
                        color: r.alerta.tiene_alto ? C.ladrillo : C.naranja }}>
                        llegando · a {r.alerta.metros} m
                      </span>
                    )}
                    {!r.alerta && r.veh_metros_a_zona != null && (
                      <span style={{ fontSize: 11, fontWeight: 700,
                        color: r.veh_metros_a_zona < 500 ? C.ladrillo : C.gris }}>
                        {r.veh_metros_a_zona < 1000
                          ? `a ${r.veh_metros_a_zona} m`
                          : `a ${(r.veh_metros_a_zona / 1000).toFixed(1)} km`}
                      </span>
                    )}
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
                  {/* Encabezado: el primer número es la SECUENCIA de la parada
                      en la ruta, no un identificador. Sin rótulo se confunde
                      con el número de envío que va al lado. */}
                  <div style={{ display: "flex", gap: 9, alignItems: "baseline",
                    padding: "5px 2px", fontSize: 10.5, fontWeight: 700,
                    letterSpacing: 0.3, textTransform: "uppercase",
                    color: C.gris, borderBottom: "1px solid var(--borde)" }}>
                    <span style={{ minWidth: 30 }}>Parada</span>
                    <span style={{ minWidth: 140 }}>Zona</span>
                    <span style={{ flex: 1 }}>Envío</span>
                    <span>Estado</span>
                  </div>
                  {(sel.paradas || []).map((p) => (
                    <div key={p.envio_id} style={{ display: "flex", gap: 9,
                      alignItems: "baseline", padding: "5px 2px", fontSize: 12,
                      borderBottom: "1px solid var(--borde)" }}>
                      <span style={{ fontWeight: 700, minWidth: 30,
                        fontVariantNumeric: "tabular-nums" }}>{p.secuencia}</span>
                      <span style={{ color: C.ladrillo, minWidth: 140 }}>{p.zona}</span>
                      <span style={{ color: C.gris, flex: 1 }}>envío {p.envio_id}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 600,
                        color: (p.estado === "complete" || p.estado === "delivered")
                          ? C.verde : C.gris }}>
                        {(p.estado === "complete" || p.estado === "delivered")
                          ? "entregada" : p.estado}
                      </span>
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
      {/* El encabezado queda FIJO al hacer scroll.
          Leaflet captura la rueda del mouse para hacer zoom, así que con el
          cursor sobre el mapa la página no se mueve. Y como el mapa mide 520 px
          más el listado, las subpestañas quedaban arriba fuera de la pantalla y
          no había forma de volver a ellas: había que recargar.

          Se fija el encabezado en vez de achicar el mapa porque el zoom con la
          rueda es lo que hace usable el dibujo, y el mapa grande es justamente
          lo que funciona bien. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8,
        marginBottom: 14, flexWrap: "wrap",
        position: "sticky", top: 0, zIndex: 500,
        background: "var(--fondo, #F7F9FC)",
        padding: "8px 0 10px" }}>
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
