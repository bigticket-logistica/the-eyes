import { estiloPrioridad, motivoLegible, estiloEstado } from "../shared/constantes.js";
import { hace } from "../shared/fechas.js";

// Orden de las rejas: de mayor a menor criticidad
const ORDEN_REJAS = ["VERY_HIGH", "HIGH", "MEDIUM", "LOW"];

function agruparPorReja(casos) {
  const rejas = {};
  for (const c of casos) {
    const p = c.prioridad || "LOW";
    (rejas[p] = rejas[p] || []).push(c);
  }
  for (const p in rejas) {
    rejas[p].sort((a, b) => new Date(a.fecha_caso) - new Date(b.fecha_caso));
  }
  const presentes = [
    ...ORDEN_REJAS.filter((p) => rejas[p]),
    ...Object.keys(rejas).filter((p) => !ORDEN_REJAS.includes(p)),
  ];
  return { rejas, presentes };
}

function Tarjeta({ c, seleccionado, onSeleccionar, analistaId, colorBorde, apagado }) {
  const activo = seleccionado?.id === c.id;
  const mio = c.analista_actual && c.analista_actual === analistaId;
  const est = estiloEstado(c.estado_id);
  return (
    <div
      onClick={() => onSeleccionar(c)}
      style={{
        padding: "9px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
        background: activo ? "var(--naranja-suave)" : "#fff",
        borderLeft: `3px solid ${activo ? "var(--naranja)" : colorBorde}`,
        opacity: apagado ? 0.62 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.estacion_origen || "—"}</span>
        <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>· {hace(c.fecha_caso)}</span>
        {apagado && (
          <span style={{
            fontSize: 10, fontWeight: 600, marginLeft: "auto",
            background: est.bg, color: est.color, padding: "1px 7px", borderRadius: 10,
          }}>{est.label}</span>
        )}
        {!apagado && mio && <span style={{ fontSize: 11, color: "var(--naranja)", marginLeft: "auto" }}>tuyo</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
        {motivoLegible(c.motivo_id, c.motivo_label)}
      </div>
      <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
        #{c.case_id}{c.conductor_nombre ? ` · ${c.conductor_nombre}` : ""}
      </div>
    </div>
  );
}

export default function ColaTickets({ casosHoy = [], cerradosHoy = [], seleccionado, onSeleccionar, analistaId }) {
  const { rejas, presentes } = agruparPorReja(casosHoy);
  const total = casosHoy.length + cerradosHoy.length;

  // cerrados de hoy: mas reciente primero
  const cerrados = [...cerradosHoy].sort((a, b) => new Date(b.fecha_caso) - new Date(a.fecha_caso));

  return (
    <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
      <div style={{
        padding: "11px 14px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, background: "#fff", zIndex: 2,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cola de hoy</span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)" }}>
          {casosHoy.length} {casosHoy.length === 1 ? "abierto" : "abiertos"}
        </span>
      </div>

      {/* REJAS DE CRITICIDAD: abiertos de hoy (lo prioritario) */}
      {presentes.map((p) => {
        const pr = estiloPrioridad(p);
        const lista = rejas[p];
        return (
          <div key={p}>
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "7px 14px", background: pr.bg,
              borderBottom: "1px solid var(--borde)",
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: pr.color }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: pr.color }}>{pr.label}</span>
              <span style={{ fontSize: 11, color: pr.color, marginLeft: "auto", opacity: 0.85 }}>
                {lista.length} {lista.length === 1 ? "caso" : "casos"}
              </span>
            </div>
            {lista.map((c) => (
              <Tarjeta key={c.id} c={c} seleccionado={seleccionado}
                onSeleccionar={onSeleccionar} analistaId={analistaId} colorBorde={pr.color} />
            ))}
          </div>
        );
      })}

      {/* CERRADOS/ANULADOS DE HOY: ya gestionados, estilo apagado */}
      {cerrados.length > 0 && (
        <div>
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "7px 14px", background: "#f6f7f9",
            borderBottom: "1px solid var(--borde)", borderTop: "1px solid var(--borde)",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#9ca3af" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#6b7280" }}>Resueltos hoy</span>
            <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto" }}>
              {cerrados.length} sin gestión pendiente
            </span>
          </div>
          {cerrados.map((c) => (
            <Tarjeta key={c.id} c={c} seleccionado={seleccionado}
              onSeleccionar={onSeleccionar} analistaId={analistaId} colorBorde="#d1d5db" apagado />
          ))}
        </div>
      )}

      {total === 0 && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--texto-tenue)", fontSize: 12 }}>
          Sin incidencias hoy
        </div>
      )}
    </div>
  );
}
