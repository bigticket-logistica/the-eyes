import { useState, useEffect, useMemo, useCallback } from "react";
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
//  Paso 1 de 3 (23-nov-2026). Los siguientes: los patrones de cada conductor
//  (días, horas, zonas) y una explicación con IA a pedido.
// ═══════════════════════════════════════════════════════════════════════════

const VENTANAS = [7, 14, 30];
const MINIMOS = [1, 3, 5];

const n = (v) => (typeof v === "number" ? v : Number(v || 0));
const pct = (v) => `${n(v).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

// Cuánto se aleja del promedio de su centro, con color según lo grave.
function VsCentro({ v }) {
  if (v === null || v === undefined) return <span style={{ color: "var(--texto-tenue)" }}>—</span>;
  const x = n(v);
  const texto = `${x.toLocaleString("es-CL", { maximumFractionDigits: 1 })}× su centro`;
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

export default function RankingCL() {
  const [filas, setFilas] = useState(null);
  const [error, setError] = useState(null);
  const [dias, setDias] = useState(7);
  const [minRutas, setMinRutas] = useState(3);
  const [filtroCeco, setFiltroCeco] = useState("");
  const [filtroSup, setFiltroSup] = useState("");
  const [busca, setBusca] = useState("");
  const [visto, setVisto] = useState(null);

  const cargar = useCallback(async () => {
    if (!sbCL) { setError("Faltan las variables de Chile en el despliegue."); return; }
    const { data, error } = await sbCL.rpc("fn_torre_ranking_cl", { p_dias: dias, p_min_rutas: minRutas });
    if (error) { setError(error.message); return; }
    setError(null);
    setFilas(data || []);
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
    [...new Set((filas || []).flatMap((f) => (f.supervisor || "").split(", ")).filter(Boolean))].sort(), [filas]);

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (filas || []).filter((f) =>
      (!filtroCeco || f.ceco === filtroCeco)
      && (!filtroSup || (f.supervisor || "").split(", ").includes(filtroSup))
      && (!q || String(f.driver_name || "").toLowerCase().includes(q)));
  }, [filas, filtroCeco, filtroSup, busca]);

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
          por porcentaje de fallidas, comparado con su centro
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--texto-tenue)" }}>
          {visto ? `visto ${visto.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi titulo="Conductores en el ranking" valor={resumen.conductores} />
        <Kpi titulo="Fallidas" valor={resumen.fallidas} color={resumen.fallidas ? "#a32d2d" : undefined} />
        <Kpi titulo="% de fallidas del grupo" valor={pct(resumen.pct)} />
        <Kpi titulo="Fallan el doble o más que su centro" valor={resumen.sobreDoble}
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
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar conductor"
          style={{ ...sel, minWidth: 180 }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 10 }}>
        Con menos rutas que el mínimo, un conductor no entra: con dos rutas, un mal día lo pone primero por
        azar. Hoy se cuenta aunque las rutas sigan en curso. Las troncales no entran.
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
                <tr key={f.driver_name} style={{ borderTop: "1px solid var(--borde)" }}>
                  <td style={{ ...td, ...num, color: "var(--texto-suave)" }}>{f.posicion}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{f.driver_name}</td>
                  <td style={td}>
                    <div>{f.ceco || <span style={{ color: "var(--texto-tenue)" }}>sin CECO</span>}</div>
                    <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{f.service_center_id}</div>
                  </td>
                  <td style={td}>{f.supervisor || <span style={{ color: "var(--texto-tenue)" }}>sin asignar</span>}</td>
                  <td style={{ ...td, ...num }}>
                    {f.rutas}
                    <span style={{ color: "var(--texto-tenue)", fontSize: 10.5 }}> en {f.dias} d</span>
                  </td>
                  <td style={{ ...td, ...num }}>{n(f.paquetes).toLocaleString("es-CL")}</td>
                  <td style={{ ...td, ...num, fontWeight: 600, color: n(f.fallidas) ? "#a32d2d" : undefined }}>
                    {f.fallidas}
                  </td>
                  <td style={td}><BarraPct v={f.pct_fallidas} /></td>
                  <td style={td} title={`Su centro: ${pct(f.pct_centro)} de fallidas`}>
                    <VsCentro v={f.vs_centro} />
                  </td>
                  <td style={{ ...td, ...num, fontSize: 11, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
                    {f.ultima_ruta ? new Date(`${f.ultima_ruta}T12:00:00`).toLocaleDateString("es-CL",
                      { day: "2-digit", month: "2-digit" }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
