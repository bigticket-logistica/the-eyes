import { estiloPrioridad, motivoLegible } from "../shared/constantes.js";
import { hace } from "../shared/fechas.js";

// Orden de las rejas: de mayor a menor criticidad
const ORDEN_REJAS = ["VERY_HIGH", "HIGH", "MEDIUM", "LOW"];

// Agrupa casos por prioridad, mas antiguo primero dentro de cada reja
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

function Tarjeta({ c, seleccionado, onSeleccionar, analistaId, colorBorde }) {
  const activo = seleccionado?.id === c.id;
  const mio = c.analista_actual && c.analista_actual === analistaId;
  return (
    <div
      onClick={() => onSeleccionar(c)}
      style={{
        padding: "9px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
        background: activo ? "var(--naranja-suave)" : "#fff",
        borderLeft: `3px solid ${activo ? "var(--naranja)" : colorBorde}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.estacion_origen || "—"}</span>
        <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>· {hace(c.fecha_caso)}</span>
        {mio && <span style={{ fontSize: 11, color: "var(--naranja)", marginLeft: "auto" }}>tuyo</span>}
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

export default function ColaTickets({ casosHoy = [], rezagados = [], seleccionado, onSeleccionar, analistaId }) {
  const { rejas, presentes } = agruparPorReja(casosHoy);
  const total = casosHoy.length + rezagados.length;

  return (
    <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
      <div style={{
        padding: "11px 14px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, background: "#fff", zIndex: 2,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cola activa</span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)" }}>{total}</span>
      </div>

      {/* BLOQUE REZAGADOS: abiertos de dias anteriores (no deberian existir) */}
      {rezagados.length > 0 && (
        <div>
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "8px 14px", background: "#FCEBEB",
            borderBottom: "1px solid #f0caca", borderTop: "2px solid #A32D2D",
          }}>
            <span style={{ fontSize: 13 }}>⚠️</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#791F1F" }}>Rezagados de días anteriores</span>
            <span style={{ fontSize: 11, color: "#A32D2D", marginLeft: "auto" }}>
              {rezagados.length} sin cerrar
            </span>
          </div>
          {rezagados
            .sort((a, b) => new Date(a.fecha_caso) - new Date(b.fecha_caso))
            .map((c) => (
              <Tarjeta key={c.id} c={c} seleccionado={seleccionado}
                onSeleccionar={onSeleccionar} analistaId={analistaId} colorBorde="#A32D2D" />
            ))}
        </div>
      )}

      {/* REJAS DE CRITICIDAD: abiertos de hoy */}
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

      {/* vacio total */}
      {total === 0 && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--texto-tenue)", fontSize: 12 }}>
          Sin incidencias abiertas
        </div>
      )}
    </div>
  );
}
