import { estiloPrioridad } from "../shared/constantes.js";
import { hace } from "../shared/fechas.js";

export default function ColaTickets({ casos, seleccionado, onSeleccionar, analistaId }) {
  // ordenar por peso de prioridad MELI, luego antiguedad (mas viejo primero)
  const ordenados = [...casos].sort((a, b) => {
    const pa = estiloPrioridad(a.prioridad).peso;
    const pb = estiloPrioridad(b.prioridad).peso;
    if (pb !== pa) return pb - pa;
    return new Date(a.fecha_caso) - new Date(b.fecha_caso);
  });

  return (
    <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
      <div style={{
        padding: "11px 14px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, background: "#fff", zIndex: 1,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cola activa</span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)" }}>{ordenados.length}</span>
      </div>

      {ordenados.map((c) => {
        const pr = estiloPrioridad(c.prioridad);
        const activo = seleccionado?.id === c.id;
        const mio = c.analista_actual && c.analista_actual === analistaId;
        return (
          <div
            key={c.id}
            onClick={() => onSeleccionar(c)}
            style={{
              padding: "11px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
              background: activo ? "var(--naranja-suave)" : "#fff",
              borderLeft: activo ? "3px solid var(--naranja)" : "3px solid transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span className="pill" style={{ background: pr.bg, color: pr.color }}>{pr.label}</span>
              <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.estacion_origen || "—"}</span>
              {mio && <span style={{ fontSize: 11, color: "var(--naranja)", marginLeft: "auto" }}>tuyo</span>}
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
              {c.motivo_label || c.motivo_id || "Incidencia"}
            </div>
            <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
              #{c.case_id} · {c.conductor_nombre || "conductor sin resolver"}
            </div>
            <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 2 }}>
              {hace(c.fecha_caso)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
