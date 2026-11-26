import { useState, useEffect, useMemo, useCallback } from "react";
import { sbCL } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
//  DETENCIONES NO AUTORIZADAS · CHILE
//
//  Regla (25-nov-2026): el chofer solo puede estar en su casa, la bodega y su
//  ruta. Si para a comprar pan o se va al mall, la Torre tiene que verlo.
//
//  Lee vw_torre_detenciones_cl del Supabase de Chile, que toma la clasificación
//  que ya hace Cuidado de Activo en el Brain (vw_paradas_cl: paradas de 10 min
//  o más de Geotab, cada 1 hora, cruzadas con las entregas de MELI y las
//  interrupciones que registra el transportista) y deja solo las no
//  autorizadas, con su CECO, supervisor y jefe:
//    · Sin respaldo          — en la calle, durante la ruta, sin entregas cerca
//    · Entrega con exceso    — hubo entrega, pero duró mucho más de lo justificado
//    · Interrupción excedida — registró colación, baño o carga y se pasó
//    · Fuera de ruta         — en la calle, fuera del horario de su ruta
//
//  Solo lectura: las decisiones (bitácora del supervisor, Conciliaciones)
//  siguen en Cuidado de Activo. Las entregas de MELI llegan con 1 a 2 h de
//  atraso: una "sin respaldo" de las últimas 2 h va marcada "por confirmar",
//  porque puede pasar a entrega y salir de la lista.
// ═══════════════════════════════════════════════════════════════════════════

const TIPOS = {
  sin_respaldo:          { corto: "Sin respaldo",          fondo: "#fdecea", color: "#a32d2d" },
  entrega_con_exceso:    { corto: "Entrega con exceso",    fondo: "#fff4e5", color: "#9a4d00" },
  interrupcion_excedida: { corto: "Interrupción excedida", fondo: "#fff4e5", color: "#9a4d00" },
  fuera_de_ruta:         { corto: "Fuera de ruta",         fondo: "#eef2f8", color: "#1f3a68" },
};

const SIN_JEFE = "Sin jefatura";
const claveJefe = (d) => d.jefe || SIN_JEFE;

const hoyCL = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
const hora = (s) => s ? new Date(s).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" }) : "—";
const fechaLarga = (f) => new Date(`${f}T12:00:00`).toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });

// "Sin respaldo" que terminó hace menos de 2 h: puede que aún no lleguen sus entregas.
const porConfirmar = (d) => d.clasificacion === "sin_respaldo"
  && (d.en_curso || !d.fin || Date.now() - new Date(d.fin).getTime() < 2 * 3600e3);

function Chip({ children, fondo, color }) {
  return (
    <span style={{ background: fondo, color, fontSize: 10.5, fontWeight: 600, padding: "2px 7px",
      borderRadius: 999, whiteSpace: "nowrap" }}>{children}</span>
  );
}

function Kpi({ titulo, valor, color = "var(--texto)", activo, onClick }) {
  return (
    <div onClick={onClick} style={{ background: "#fff", border: `1px solid ${activo ? color : "var(--borde)"}`,
      borderRadius: 10, padding: "10px 14px", minWidth: 120, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>{titulo}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color }}>{valor}</div>
    </div>
  );
}

// Lo que explica cada detención, en una línea.
function Detalle({ d }) {
  const tenue = { color: "var(--texto-tenue)" };
  if (d.clasificacion === "entrega_con_exceso") {
    return <span>{d.paquetes} paq. entregados a {d.dist_min_m ?? "—"} m · <b>{d.min_sin_explicar} min</b> sin explicar</span>;
  }
  if (d.clasificacion === "interrupcion_excedida") {
    const t = String(d.interrupcion_tipos || "").replace("colacion", "colación").replace("bano", "baño");
    return <span>Registró {t || "interrupción"} ({d.interrupcion_min} min) · <b>{d.min_sin_explicar} min</b> de más</span>;
  }
  if (d.clasificacion === "fuera_de_ruta") {
    return d.hora_inicio_ruta
      ? <span>Su ruta: {d.hora_inicio_ruta} – {d.hora_fin_ruta || "en curso"}</span>
      : <span style={tenue}>Sin ruta de MELI ese día</span>;
  }
  return <span>En la calle, sin entregas cerca{d.hora_inicio_ruta ? <span style={tenue}> · ruta {d.hora_inicio_ruta} – {d.hora_fin_ruta || "en curso"}</span> : null}</span>;
}

export default function DetencionesCL() {
  const [filas, setFilas] = useState(null);
  const [error, setError] = useState(null);
  const [fecha, setFecha] = useState(hoyCL());
  const [jefatura, setJefatura] = useState("");
  const [tipo, setTipo] = useState("");
  const [busca, setBusca] = useState("");
  const [visto, setVisto] = useState(null);

  const cargar = useCallback(async () => {
    if (!sbCL) { setError("Faltan las variables de Chile en el despliegue."); return; }
    const { data, error } = await sbCL.from("vw_torre_detenciones_cl").select("*")
      .eq("fecha", fecha).order("inicio", { ascending: false }).limit(2000);
    if (error) { setError(error.message); return; }
    setError(null);
    setFilas(data || []);
    setVisto(new Date());
  }, [fecha]);

  useEffect(() => {
    setFilas(null);
    cargar();
    // Las paradas de Geotab entran cada hora; releer cada 5 minutos basta.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 5 * 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const jefaturas = useMemo(() => {
    const c = new Map();
    for (const d of filas || []) c.set(claveJefe(d), (c.get(claveJefe(d)) || 0) + 1);
    return [...c.entries()].sort((a, b) => (a[0] === SIN_JEFE) - (b[0] === SIN_JEFE) || a[0].localeCompare(b[0]));
  }, [filas]);

  // Lo que pasa jefatura y búsqueda: sobre esto se cuentan los KPI.
  const base = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (filas || []).filter((d) => (!jefatura || claveJefe(d) === jefatura)
      && (!q || [d.patente, d.conductor, d.ceco].some((v) => String(v || "").toLowerCase().includes(q))));
  }, [filas, jefatura, busca]);

  const cuenta = (k) => base.filter((d) => d.clasificacion === k).length;
  const visibles = base.filter((d) => !tipo || (tipo === "confirmar" ? porConfirmar(d) : d.clasificacion === tipo));

  // Un bloque por jefatura; dentro, de la más reciente a la más antigua.
  const bloques = useMemo(() => {
    const m = new Map();
    for (const d of visibles) {
      if (!m.has(claveJefe(d))) m.set(claveJefe(d), []);
      m.get(claveJefe(d)).push(d);
    }
    return [...m.entries()].sort((a, b) => (a[0] === SIN_JEFE) - (b[0] === SIN_JEFE) || a[0].localeCompare(b[0]));
  }, [visibles]);

  const minFecha = new Date(Date.now() - 6 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
  const th = { padding: "8px 10px", fontSize: 11, color: "var(--texto-suave)", textAlign: "left", fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap" };
  const td = { padding: "8px 10px", fontSize: 12.5, verticalAlign: "top", borderTop: "1px solid var(--borde)" };
  const ctl = { padding: "6px 10px", border: "1px solid var(--borde)", borderRadius: 8, fontSize: 13, background: "#fff" };

  if (error) {
    return <div style={{ padding: 24, color: "#791F1F" }}>No se pudieron leer las detenciones de Chile: {error}</div>;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Detenciones no autorizadas · Chile</h2>
        <span style={{ fontSize: 12, color: "var(--texto-suave)" }}>{fechaLarga(fecha)}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--texto-tenue)" }}>
          {visto ? `visto ${visto.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Kpi titulo="Detenciones" valor={base.length} activo={!tipo} onClick={() => setTipo("")} />
        {Object.entries(TIPOS).map(([k, t]) => (
          <Kpi key={k} titulo={t.corto} valor={cuenta(k)} color={t.color}
            activo={tipo === k} onClick={() => setTipo(tipo === k ? "" : k)} />
        ))}
        <Kpi titulo="Por confirmar (últimas 2 h)" valor={base.filter(porConfirmar).length} color="#6b7280"
          activo={tipo === "confirmar"} onClick={() => setTipo(tipo === "confirmar" ? "" : "confirmar")} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input type="date" style={ctl} value={fecha} min={minFecha} max={hoyCL()}
          onChange={(e) => e.target.value && setFecha(e.target.value)} />
        <select style={ctl} value={jefatura} onChange={(e) => setJefatura(e.target.value)}>
          <option value="">Todas las jefaturas</option>
          {jefaturas.map(([j, n]) => <option key={j} value={j}>{j} ({n})</option>)}
        </select>
        <input style={{ ...ctl, minWidth: 240 }} placeholder="Conductor, patente o CECO" value={busca}
          onChange={(e) => setBusca(e.target.value)} />
        <button style={{ ...ctl, cursor: "pointer" }} onClick={cargar}>Actualizar</button>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginBottom: 12, lineHeight: 1.5 }}>
        Paradas de 10 min o más de Geotab (cada 1 hora), cruzadas con las entregas de MELI y las interrupciones
        que registra el transportista, según la clasificación de Cuidado de Activo. No entran las paradas en la
        bodega o en su estacionamiento, ni los camiones de otros clientes. Las entregas de MELI llegan con 1 a 2 h
        de atraso: una "sin respaldo" reciente puede pasar a entrega y salir de la lista. Las decisiones se toman
        en Cuidado de Activo.
      </div>

      {filas === null ? (
        <div style={{ color: "var(--texto-suave)" }}>Cargando…</div>
      ) : visibles.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)", background: "#fff",
          border: "1px solid var(--borde)", borderRadius: 10 }}>Sin detenciones con este filtro.</div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
            <thead>
              <tr>
                {["Hora", "Min", "Tipo", "Conductor", "CECO · supervisor", "Qué pasó", "Mapa"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bloques.map(([jefe, ds]) => [
                <tr key={`j-${jefe}`}>
                  <td colSpan={7} style={{ ...td, background: "#f3f5f9", fontWeight: 600, fontSize: 12 }}>
                    {jefe} <span style={{ color: "var(--texto-suave)", fontWeight: 400 }}>· {ds.length} detención{ds.length === 1 ? "" : "es"}</span>
                  </td>
                </tr>,
                ...ds.map((d) => {
                  const t = TIPOS[d.clasificacion] || { corto: d.clasificacion, fondo: "#eee", color: "#555" };
                  return (
                    <tr key={d.id}>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {hora(d.inicio)} – {d.en_curso ? <b style={{ color: "#9a4d00" }}>en curso</b> : hora(d.fin)}
                      </td>
                      <td style={{ ...td, fontWeight: 600, color: d.minutos >= 45 ? "#a32d2d" : "var(--texto)" }}>{d.minutos}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          <Chip fondo={t.fondo} color={t.color}>{t.corto}</Chip>
                          {porConfirmar(d) && <Chip fondo="#f1f2f4" color="#6b7280">por confirmar</Chip>}
                          {d.camara_cubierta && <Chip fondo="#fdecea" color="#a32d2d">cámara tapada</Chip>}
                        </div>
                      </td>
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{d.conductor || "sin conductor"}</div>
                        <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{d.patente}</div>
                      </td>
                      <td style={td}>
                        <div>{d.ceco || <span style={{ color: "var(--texto-tenue)" }}>sin CECO</span>}
                          {d.facility && <span style={{ color: "var(--texto-tenue)", fontSize: 10.5 }}> {d.facility}</span>}</div>
                        <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{d.supervisor || "sin supervisor"}</div>
                      </td>
                      <td style={{ ...td, maxWidth: 380 }}><Detalle d={d} /></td>
                      <td style={td}>
                        {d.lat != null && (
                          <a href={`https://maps.google.com/?q=${d.lat},${d.lng}`} target="_blank" rel="noreferrer"
                            style={{ color: "#1f3a68", whiteSpace: "nowrap" }}>🗺️ Ver</a>
                        )}
                      </td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
