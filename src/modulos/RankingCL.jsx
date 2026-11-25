import { useState, useEffect, useMemo, useCallback, Fragment } from "react";
import { sbCL } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
//  RANKING DE CONDUCTORES · CHILE
//
//  Quién falla más, ordenado por PORCENTAJE de fallidas sobre sus paquetes y
//  no por cantidad: quien hace rutas grandes acumula más fallidas sin fallar
//  más. Cada conductor se compara con el promedio de su propio centro, porque
//  no todos los centros tienen la misma dificultad.
//
//  Lee fn_torre_ranking_cl del Supabase de Chile, que sale del resumen diario
//  de rutas (rutas_dia_cl, refrescado cada 15 minutos). Las troncales no
//  entran: no reparten a domicilio.
//
//  CECO, supervisor y jefe salen del maestro del Brain (Mantenedores): la
//  camioneta que más usó el conductor en el período, su supervisor en
//  vw_vehiculos_bt y el líder de ese supervisor en lideres_supervisores_cl.
//
//  Paso 1 de 3 (23-nov-2026). Los siguientes: los patrones de cada conductor
//  (días, horas, zonas) y una explicación con IA a pedido.
//
//  Eventos (24-nov-2026): los hitos de eventos_operativos_cl dentro de la
//  ventana se muestran arriba. Las rutas de un evento marcado para excluir no
//  cuentan en el ranking; cada conductor muestra cuántas le quedaron fuera
//  (rutas_excluidas). Las rutas sin conductor asignado (driver "-") tampoco.
//
//  Detalle por conductor (25-nov-2026, paso 2 de 3): clic en un conductor abre
//  bajo su fila fn_torre_conductor_detalle_cl: fallidas por día de la semana,
//  por hora (fallidas_hora_cl), por zona de la ruta (Brain) y sus últimas rutas.
//  Cada ruta cuenta una vez, en el día en que empezó (vw_rutas_unicas_cl).
// ═══════════════════════════════════════════════════════════════════════════

const VENTANAS = [7, 14, 30];
const MINIMOS = [1, 3, 5];

// Fecha de hoy en Chile, como "AAAA-MM-DD".
const hoyChile = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });

// Primer día de la ventana: la misma regla que fn_torre_ranking_cl
// (fecha > hoy − días, o sea desde hoy − días + 1).
function desdeVentana(dias) {
  const d = new Date(`${hoyChile()}T12:00:00`);
  d.setDate(d.getDate() - dias + 1);
  return d.toLocaleDateString("en-CA");
}

const fechaCorta = (f) =>
  new Date(`${f}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" });

const n = (v) => (typeof v === "number" ? v : Number(v || 0));
const pct = (v) => `${n(v).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

// Cuánto se aleja del promedio de su centro, con color según lo grave.
function VsCentro({ v }) {
  if (v === null || v === undefined) return <span style={{ color: "var(--texto-tenue)" }}>—</span>;
  const x = n(v);
  const texto = `${x.toLocaleString("es-CL", { maximumFractionDigits: 1 })}× su CECO`;
  const [fondo, color] =
    x >= 2   ? ["#fdecea", "#a32d2d"] :
    x >= 1.5 ? ["#fff4e5", "#9a4d00"] :
    x < 1    ? ["#e7f6ef", "#13724f"] :
               ["#f1f5f9", "#475569"];
  return (
    <span style={{ background: fondo, color, fontSize: 10.5, fontWeight: 600, padding: "2px 7px",
      borderRadius: 999, whiteSpace: "nowrap" }}>{texto}</span>
  );
}

// Barra del porcentaje. La escala llega a 6 %: en Chile el peor conductor ronda
// el 5 %, y con una escala de 100 % todas las barras se verían vacías.
function BarraPct({ v }) {
  const x = n(v);
  const ancho = Math.min(100, (x / 6) * 100);
  const color = x >= 4 ? "#a32d2d" : x >= 2.5 ? "#C25A08" : "var(--navy)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: "#e8edf3", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${ancho}%`, height: "100%", background: color, borderRadius: 999 }} />
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 38,
        textAlign: "right" }}>{pct(x)}</span>
    </div>
  );
}

// ── Detalle de un conductor ────────────────────────────────────────────────
const DIAS_SEMANA = ["", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function Barras({ items, max, color = "#a32d2d" }) {
  // items: [{ etiqueta, valor, texto, nota }]
  const tope = max || Math.max(1, ...items.map((i) => i.valor));
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {items.map((i) => (
        <div key={i.etiqueta} style={{ display: "grid", gridTemplateColumns: "64px 1fr 84px", gap: 6,
          alignItems: "center", fontSize: 11.5 }}>
          <span style={{ color: "var(--texto-suave)", whiteSpace: "nowrap", overflow: "hidden",
            textOverflow: "ellipsis" }} title={i.etiqueta}>{i.etiqueta}</span>
          <div style={{ height: 8, background: "#e8edf3", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, (i.valor / tope) * 100)}%`, height: "100%",
              background: color, borderRadius: 999 }} />
          </div>
          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }} title={i.nota || ""}>
            {i.texto}
          </span>
        </div>
      ))}
    </div>
  );
}

function Bloque({ titulo, nota, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3,
        color: "var(--texto-suave)", marginBottom: 8 }}>{titulo}</div>
      {children}
      {nota && <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 8 }}>{nota}</div>}
    </div>
  );
}

function DetalleConductor({ driver, dias }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let vivo = true;
    setD(null); setError(null);
    sbCL.rpc("fn_torre_conductor_detalle_cl", { p_driver: driver, p_dias: dias }).then(({ data, error }) => {
      if (!vivo) return;
      if (error) setError(error.message); else setD(data || {});
    });
    return () => { vivo = false; };
  }, [driver, dias]);

  if (error) return <div style={{ padding: 12, color: "#791F1F", fontSize: 12.5 }}>No se pudo leer el detalle: {error}</div>;
  if (!d) return <div style={{ padding: 12, color: "var(--texto-suave)", fontSize: 12.5 }}>Cargando detalle…</div>;

  const pctDe = (f, p) => (p ? (100 * f) / p : 0);
  const diasItems = (d.dias || []).map((x) => ({
    etiqueta: `${DIAS_SEMANA[x.dow]} · ${x.rutas} r`,
    valor: pctDe(x.fallidas, x.paquetes),
    texto: `${x.fallidas} · ${pct(pctDe(x.fallidas, x.paquetes))}`,
    nota: `${x.rutas} rutas, ${n(x.paquetes).toLocaleString("es-CL")} paquetes`,
  }));
  const horasItems = (d.horas || []).map((x) => ({
    etiqueta: x.hora < 0 ? "sin hora" : `${String(x.hora).padStart(2, "0")}:00`,
    valor: x.fallidas,
    texto: `${x.fallidas}`,
  }));
  const zonasItems = (d.zonas || []).map((x) => ({
    etiqueta: x.zona,
    valor: pctDe(x.fallidas, x.paquetes),
    texto: `${x.fallidas} · ${pct(pctDe(x.fallidas, x.paquetes))}`,
    nota: `${x.rutas} rutas, ${n(x.paquetes).toLocaleString("es-CL")} paquetes`,
  }));
  const vacio = <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>Sin datos en la ventana.</div>;

  return (
    <div style={{ padding: "12px 14px", background: "var(--fondo, #f7f8fa)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        <Bloque titulo="Por día de la semana" nota="Fallidas y % sobre sus paquetes de ese día.">
          {diasItems.length ? <Barras items={diasItems} /> : vacio}
        </Bloque>
        <Bloque titulo="Por hora"
          nota="Cada vez que se marcó una fallida, aunque después se entregara. Desde el 10-nov.">
          {horasItems.length ? <Barras items={horasItems} color="#C25A08" /> : vacio}
        </Bloque>
        <Bloque titulo="Por zona de la ruta" nota="Zona principal según el Brain. Las de hoy aún no tienen zona.">
          {zonasItems.length ? <Barras items={zonasItems} /> : vacio}
        </Bloque>
      </div>

      <Bloque titulo={`Últimas rutas${d.excluidas ? ` · ${d.excluidas} excluida(s) por evento` : ""}`}>
        {(d.rutas || []).length === 0 ? vacio : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--texto-suave)", fontSize: 10.5 }}>
                  <th style={{ padding: "4px 6px" }}>Fecha</th>
                  <th style={{ padding: "4px 6px" }}>Ruta</th>
                  <th style={{ padding: "4px 6px" }}>CECO · despacho</th>
                  <th style={{ padding: "4px 6px" }}>Zona</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Paquetes</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Entregados</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Fallidas</th>
                </tr>
              </thead>
              <tbody>
                {d.rutas.map((r) => (
                  <tr key={r.id_ruta} style={{ borderTop: "1px solid var(--borde)" }}>
                    <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{fechaCorta(r.fecha)}</td>
                    <td style={{ padding: "4px 6px", fontVariantNumeric: "tabular-nums" }}>{r.id_ruta}</td>
                    <td style={{ padding: "4px 6px" }}>
                      {r.ceco || "—"} <span style={{ color: "var(--texto-tenue)" }}>{r.facility || ""}</span>
                    </td>
                    <td style={{ padding: "4px 6px" }}>{r.zona || <span style={{ color: "var(--texto-tenue)" }}>—</span>}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{n(r.paquetes).toLocaleString("es-CL")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{n(r.entregados).toLocaleString("es-CL")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right", fontWeight: 600,
                      color: n(r.fallidas) ? "#a32d2d" : "var(--texto-tenue)" }}>{r.fallidas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloque>
    </div>
  );
}

export default function RankingCL() {
  const [filas, setFilas] = useState(null);
  const [eventos, setEventos] = useState([]);
  const [error, setError] = useState(null);
  const [dias, setDias] = useState(7);
  const [minRutas, setMinRutas] = useState(3);
  const [filtroCeco, setFiltroCeco] = useState("");
  const [filtroSup, setFiltroSup] = useState("");
  const [filtroJefe, setFiltroJefe] = useState("");
  const [busca, setBusca] = useState("");
  const [visto, setVisto] = useState(null);
  const [abierto, setAbierto] = useState(null); // conductor con el detalle abierto

  const cargar = useCallback(async () => {
    if (!sbCL) { setError("Faltan las variables de Chile en el despliegue."); return; }
    const [rk, ev] = await Promise.all([
      sbCL.rpc("fn_torre_ranking_cl", { p_dias: dias, p_min_rutas: minRutas }),
      sbCL.from("eventos_operativos_cl").select("*").gte("fecha", desdeVentana(dias)).order("fecha"),
    ]);
    if (rk.error) { setError(rk.error.message); return; }
    setError(null);
    setFilas(rk.data || []);
    // Si los eventos no se pueden leer, el ranking se muestra igual, sin el aviso.
    setEventos(ev.error ? [] : (ev.data || []));
    setVisto(new Date());
  }, [dias, minRutas]);

  useEffect(() => {
    cargar();
    // El resumen se refresca cada 15 minutos; releer cada 5 alcanza.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 300000);
    return () => clearInterval(t);
  }, [cargar]);

  const cecos = useMemo(() =>
    [...new Set((filas || []).map((f) => f.ceco).filter(Boolean))].sort(), [filas]);
  const supervisores = useMemo(() =>
    [...new Set((filas || []).map((f) => f.supervisor).filter(Boolean))].sort(), [filas]);
  const jefes = useMemo(() =>
    [...new Set((filas || []).map((f) => f.jefe).filter(Boolean))].sort(), [filas]);

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (filas || []).filter((f) =>
      (!filtroCeco || f.ceco === filtroCeco)
      && (!filtroSup || f.supervisor === filtroSup)
      && (!filtroJefe || f.jefe === filtroJefe)
      && (!q || [f.driver_name, f.patente].some((v) => String(v || "").toLowerCase().includes(q))));
  }, [filas, filtroCeco, filtroSup, filtroJefe, busca]);

  const resumen = useMemo(() => {
    const paq = visibles.reduce((a, f) => a + n(f.paquetes), 0);
    const fal = visibles.reduce((a, f) => a + n(f.fallidas), 0);
    return {
      conductores: visibles.length,
      fallidas: fal,
      pct: paq ? (100 * fal) / paq : 0,
      sobreDoble: visibles.filter((f) => n(f.vs_centro) >= 2).length,
    };
  }, [visibles]);

  if (error) {
    return <div style={{ padding: 20, color: "#791F1F", fontSize: 13 }}>
      No se pudo leer el ranking de Chile: {error}
    </div>;
  }
  if (filas === null) {
    return <div style={{ padding: 20, color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>;
  }

  const Kpi = ({ titulo, valor, color }) => (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
      padding: "9px 14px", minWidth: 130 }}>
      <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>{titulo}</div>
      <div style={{ fontSize: 21, fontWeight: 600, color: color || "inherit",
        fontVariantNumeric: "tabular-nums" }}>{valor}</div>
    </div>
  );

  const sel = { fontSize: 12.5, padding: "5px 8px", borderRadius: 7, border: "1px solid var(--borde)",
    background: "#fff" };
  const th = { padding: "7px 10px", fontWeight: 600 };
  const td = { padding: "7px 10px" };
  const num = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>Ranking de Conductores · Chile</strong>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>
          por porcentaje de fallidas, comparado con su CECO
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--texto-tenue)" }}>
          {visto ? `visto ${visto.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      {eventos.length > 0 && (
        <div style={{ background: "#fff8e6", border: "1px solid #f0d58a", borderRadius: 10,
          padding: "9px 14px", marginBottom: 14, fontSize: 12.5 }}>
          {eventos.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }}>
              <span>📌</span>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                {fechaCorta(e.fecha)}{e.hora_desde !== null && e.hora_desde !== undefined
                  ? ` desde las ${String(e.hora_desde).padStart(2, "0")}:00` : ""}
              </span>
              <span style={{ color: "var(--texto-suave)", whiteSpace: "nowrap" }}>
                {(e.facility_ids || []).join(", ")}
              </span>
              <span style={{ flex: 1 }}>{e.descripcion}</span>
              {e.excluir_ranking && (
                <span style={{ fontSize: 10.5, color: "#7a5a00", whiteSpace: "nowrap" }}>
                  excluido del ranking
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi titulo="Conductores en el ranking" valor={resumen.conductores} />
        <Kpi titulo="Fallidas" valor={resumen.fallidas} color={resumen.fallidas ? "#a32d2d" : undefined} />
        <Kpi titulo="% de fallidas del grupo" valor={pct(resumen.pct)} />
        <Kpi titulo="Fallan el doble o más que su CECO" valor={resumen.sobreDoble}
          color={resumen.sobreDoble ? "#a32d2d" : "#1D9E75"} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5 }}>Últimos{" "}
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} style={sel}>
            {VENTANAS.map((d) => <option key={d} value={d}>{d} días</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12.5 }}>Mínimo{" "}
          <select value={minRutas} onChange={(e) => setMinRutas(Number(e.target.value))} style={sel}>
            {MINIMOS.map((m) => <option key={m} value={m}>{m} {m === 1 ? "ruta" : "rutas"}</option>)}
          </select>
        </label>
        <select value={filtroCeco} onChange={(e) => setFiltroCeco(e.target.value)} style={sel}>
          <option value="">Todos los CECO</option>
          {cecos.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filtroSup} onChange={(e) => setFiltroSup(e.target.value)} style={sel}>
          <option value="">Todos los supervisores</option>
          {supervisores.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filtroJefe} onChange={(e) => setFiltroJefe(e.target.value)} style={sel}>
          <option value="">Todos los jefes</option>
          {jefes.map((j) => <option key={j} value={j}>{j}</option>)}
        </select>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Conductor o patente"
          style={{ ...sel, minWidth: 180 }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 10 }}>
        Con menos rutas que el mínimo, un conductor no entra: con dos rutas, un mal día lo pone primero por
        azar. Hoy se cuenta aunque las rutas sigan en curso. Las troncales, las rutas sin conductor
        asignado y las de eventos marcados para excluir no entran. CECO, supervisor y
        jefe son los de la camioneta que más usó en el período, según el maestro de Mantenedores.
      </div>

      {visibles.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)", fontSize: 13,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10 }}>
          Ningún conductor con estos filtros.
        </div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--texto-suave)", fontSize: 10.5,
                textTransform: "uppercase", letterSpacing: 0.3, background: "var(--fondo, #f7f8fa)" }}>
                <th style={{ ...th, ...num, width: 34 }}>#</th>
                <th style={th}>Conductor</th>
                <th style={th}>CECO · centro</th>
                <th style={th}>Supervisor</th>
                <th style={th}>Jefe</th>
                <th style={{ ...th, ...num }}>Rutas</th>
                <th style={{ ...th, ...num }}>Paquetes</th>
                <th style={{ ...th, ...num }}>Fallidas</th>
                <th style={th}>% fallidas</th>
                <th style={th}>Comparado</th>
                <th style={{ ...th, ...num }}>Última ruta</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((f) => (
                <Fragment key={f.driver_name}>
                <tr onClick={() => setAbierto(abierto === f.driver_name ? null : f.driver_name)}
                  title="Clic para ver su detalle"
                  style={{ borderTop: "1px solid var(--borde)", cursor: "pointer",
                    background: abierto === f.driver_name ? "#eef2f8" : undefined }}>
                  <td style={{ ...td, ...num, color: "var(--texto-suave)" }}>{f.posicion}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>
                      <span style={{ color: "var(--texto-tenue)", fontSize: 10, marginRight: 4 }}>
                        {abierto === f.driver_name ? "▾" : "▸"}
                      </span>
                      {f.driver_name}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{f.patente || "sin patente"}</div>
                  </td>
                  <td style={td}>
                    {/* Sin CECO casi siempre es una camioneta que no está en el
                        maestro: se dice, para que se pueda corregir allá. */}
                    <div>{f.ceco || <span style={{ color: "#9a4d00" }}>no está en el maestro</span>}</div>
                    <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{f.service_center_id}</div>
                  </td>
                  <td style={td}>{f.supervisor || <span style={{ color: "var(--texto-tenue)" }}>sin asignar</span>}</td>
                  <td style={td}>
                    <div>{f.jefe || <span style={{ color: "var(--texto-tenue)" }}>sin asignar</span>}</div>
                    {f.zona && <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{f.zona}</div>}
                  </td>
                  <td style={{ ...td, ...num }}>
                    {f.rutas}
                    <span style={{ color: "var(--texto-tenue)", fontSize: 10.5 }}> en {f.dias} d</span>
                    {n(f.rutas_excluidas) > 0 && (
                      <div style={{ fontSize: 10.5, color: "#7a5a00" }}
                        title="Rutas de un evento operativo: no cuentan en su porcentaje">
                        📌 +{f.rutas_excluidas} {n(f.rutas_excluidas) === 1 ? "excluida" : "excluidas"} por evento
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, ...num }}>{n(f.paquetes).toLocaleString("es-CL")}</td>
                  <td style={{ ...td, ...num, fontWeight: 600, color: n(f.fallidas) ? "#a32d2d" : undefined }}>
                    {f.fallidas}
                  </td>
                  <td style={td}><BarraPct v={f.pct_fallidas} /></td>
                  <td style={td} title={`Su CECO: ${pct(f.pct_centro)} de fallidas`}>
                    <VsCentro v={f.vs_centro} />
                  </td>
                  <td style={{ ...td, ...num, fontSize: 11, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
                    {f.ultima_ruta ? new Date(`${f.ultima_ruta}T12:00:00`).toLocaleDateString("es-CL",
                      { day: "2-digit", month: "2-digit" }) : "—"}
                  </td>
                </tr>
                {abierto === f.driver_name && (
                  <tr>
                    <td colSpan={11} style={{ padding: 0, borderTop: "1px solid var(--borde)" }}>
                      <DetalleConductor driver={f.driver_name} dias={dias} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
