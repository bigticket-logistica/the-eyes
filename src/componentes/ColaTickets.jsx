import { estiloPrioridad, motivoLegible } from "../shared/constantes.js";
import { hace } from "../shared/fechas.js";

// Orden de las rejas: de mayor a menor criticidad
const ORDEN_REJAS = ["VERY_HIGH", "HIGH", "MEDIUM", "LOW"];

export default function ColaTickets({ casos, seleccionado, onSeleccionar, analistaId }) {
  // Agrupar casos por prioridad
  const rejas = {};
  for (const c of casos) {
    const p = c.prioridad || "LOW";
    (rejas[p] = rejas[p] || []).push(c);
  }

  // Dentro de cada reja, mas antiguo primero (el que mas lleva esperando)
  for (const p in rejas) {
    rejas[p].sort((a, b) => new Date(a.fecha_caso) - new Date(b.fecha_caso));
  }

  // Prioridades a mostrar, en orden de criticidad, solo las que tienen casos.
  // (cualquier prioridad no listada en ORDEN_REJAS cae al final)
  const prioridadesPresentes = [
    ...ORDEN_REJAS.filter((p) => rejas[p]),
    ...Object.keys(rejas).filter((p) => !ORDEN_REJAS.includes(p)),
  ];

  return (
    <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
      <div style={{
        padding: "11px 14px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, background: "#fff", zIndex: 2,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cola activa</span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)" }}>{casos.length}</span>
      </div>

      {prioridadesPresentes.map((p) => {
        const pr = estiloPrioridad(p);
        const lista = rejas[p];
        return (
          <div key={p}>
            {/* Encabezado de la reja */}
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "7px 14px", background: pr.bg,
              borderBottom: "1px solid var(--borde)",
              position: "sticky", top: 39, zIndex: 1,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: pr.color }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: pr.color }}>{pr.label}</span>
              <span style={{ fontSize: 11, color: pr.color, marginLeft: "auto", opacity: 0.85 }}>
                {lista.length} {lista.length === 1 ? "caso" : "casos"}
              </span>
            </div>

            {/* Casos de la reja */}
            {lista.map((c) => {
              const activo = seleccionado?.id === c.id;
              const mio = c.analista_actual && c.analista_actual === analistaId;
              return (
                <div
                  key={c.id}
                  onClick={() => onSeleccionar(c)}
                  style={{
                    padding: "9px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                    background: activo ? "var(--naranja-suave)" : "#fff",
                    borderLeft: `3px solid ${activo ? "var(--naranja)" : pr.color}`,
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
            })}
          </div>
        );
      })}
    </div>
  );
}
