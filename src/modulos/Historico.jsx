import { useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { detalleEstado, estiloPrioridad, motivoLegible, ESTADOS_DETALLE } from "../shared/constantes.js";
import { fechaHora, hace } from "../shared/fechas.js";
import HiloTicket from "../componentes/HiloTicket.jsx";
import PanelContexto from "../componentes/PanelContexto.jsx";

// opciones de estado para el filtro (del diccionario validado)
const OPCIONES_ESTADO = [
  { v: "", t: "Todos los estados" },
  { v: "NEW", t: "Nuevo" },
  { v: "ON_HOLD", t: "Esperando respuesta" },
  { v: "CLOSED", t: "Cerrado (cualquiera)" },
  { v: "CANCELLED", t: "Anulado" },
];

export default function Historico() {
  const { analista } = useAuth();
  const [filtros, setFiltros] = useState({ caso: "", desde: "", hasta: "", estado: "", sc: "" });
  const [resultados, setResultados] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [seleccionado, setSeleccionado] = useState(null);
  const [buscado, setBuscado] = useState(false);

  const set = (k) => (e) => setFiltros((f) => ({ ...f, [k]: e.target.value }));

  const buscar = useCallback(async () => {
    setCargando(true); setError(null); setBuscado(true);
    try {
      let q = sb.from("crm_inc_casos")
        .select("id, case_id, motivo_id, motivo_label, estado_id, sub_estado_id, prioridad, estacion_origen, route_code, conductor_nombre, conductor_telefono, comentario_cierre, analista_actual, fecha_caso, detalle_actualizado_en")
        .order("fecha_caso", { ascending: false })
        .limit(100);

      // búsqueda directa por número de caso (ignora otros filtros)
      if (filtros.caso.trim()) {
        q = sb.from("crm_inc_casos")
          .select("id, case_id, motivo_id, motivo_label, estado_id, sub_estado_id, prioridad, estacion_origen, route_code, conductor_nombre, conductor_telefono, comentario_cierre, analista_actual, fecha_caso, detalle_actualizado_en")
          .eq("case_id", parseInt(filtros.caso.replace(/\D/g, ""), 10))
          .limit(20);
      } else {
        if (filtros.desde) q = q.gte("fecha_caso", filtros.desde + "T00:00:00");
        if (filtros.hasta) q = q.lte("fecha_caso", filtros.hasta + "T23:59:59");
        if (filtros.estado) q = q.eq("estado_id", filtros.estado);
        if (filtros.sc) q = q.ilike("estacion_origen", filtros.sc.trim());
      }
      const { data, error } = await q;
      if (error) throw error;
      setResultados(data || []);
    } catch (e) {
      setError(e.message); setResultados([]);
    } finally {
      setCargando(false);
    }
  }, [filtros]);

  const inputStyle = { padding: "7px 10px", fontSize: 13, border: "1px solid var(--borde)", borderRadius: 7 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) 1.4fr minmax(280px, 0.9fr)", height: "100%" }}>
      {/* columna 1: filtros + resultados */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff", display: "flex", flexDirection: "column" }}>
        {/* filtros */}
        <div style={{ padding: 14, borderBottom: "1px solid var(--borde)", display: "flex", flexDirection: "column", gap: 8, position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Buscar casos</div>
          <input placeholder="N° de caso (búsqueda directa)" value={filtros.caso}
            onChange={set("caso")} onKeyDown={(e) => e.key === "Enter" && buscar()} style={inputStyle} />
          <div style={{ fontSize: 11, color: "var(--texto-tenue)", textAlign: "center" }}>— o filtra —</div>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, fontSize: 11, color: "var(--texto-suave)" }}>Desde
              <input type="date" value={filtros.desde} onChange={set("desde")} style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
            </label>
            <label style={{ flex: 1, fontSize: 11, color: "var(--texto-suave)" }}>Hasta
              <input type="date" value={filtros.hasta} onChange={set("hasta")} style={{ ...inputStyle, width: "100%", marginTop: 2 }} />
            </label>
          </div>
          <select value={filtros.estado} onChange={set("estado")} style={inputStyle}>
            {OPCIONES_ESTADO.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
          </select>
          <input placeholder="SC / estación (ej. SMX1)" value={filtros.sc} onChange={set("sc")}
            onKeyDown={(e) => e.key === "Enter" && buscar()} style={inputStyle} />
          <button className="btn-navy" onClick={buscar} disabled={cargando} style={{ padding: "8px", marginTop: 2 }}>
            {cargando ? "Buscando…" : "Buscar"}
          </button>
        </div>

        {/* resultados */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {error && <div style={{ padding: 14, fontSize: 12, color: "#bb4444" }}>{error}</div>}
          {buscado && !cargando && resultados.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>Sin resultados</div>
          )}
          {!buscado && (
            <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--texto-tenue)" }}>
              Busca por número de caso o aplica filtros.
            </div>
          )}
          {resultados.map((c) => {
            const est = detalleEstado(c.estado_id, c.sub_estado_id);
            const activo = seleccionado?.id === c.id;
            return (
              <div key={c.id} onClick={() => setSeleccionado(c)}
                style={{ padding: "9px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                  background: activo ? "var(--naranja-suave)" : "#fff",
                  borderLeft: `3px solid ${activo ? "var(--naranja)" : "transparent"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.estacion_origen || "—"}</span>
                  <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>· {fechaHora(c.fecha_caso)}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, marginLeft: "auto", background: est.bg, color: est.color, padding: "1px 7px", borderRadius: 10 }}>{est.label}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{motivoLegible(c.motivo_id, c.motivo_label)}</div>
                <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                  #{c.case_id}{c.conductor_nombre ? ` · ${c.conductor_nombre}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* columna 2: hilo del caso seleccionado */}
      <HiloTicket caso={seleccionado} onTomar={() => {}} onResolver={() => {}} analistaId={analista?.id} />

      {/* columna 3: panel de contexto */}
      <PanelContexto caso={seleccionado} />
    </div>
  );
}
