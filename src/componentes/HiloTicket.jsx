import { estiloEstado, estiloPrioridad, motivoLegible } from "../shared/constantes.js";
import { hace } from "../shared/fechas.js";

export default function HiloTicket({ caso, onTomar, onResolver, analistaId }) {
  if (!caso) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)", borderRight: "1px solid var(--borde)" }}>
        Selecciona un ticket de la cola
      </div>
    );
  }

  const est = estiloEstado(caso.estado_id);
  const pr = estiloPrioridad(caso.prioridad);
  const esMio = caso.analista_actual && caso.analista_actual === analistaId;
  const sinDueno = !caso.analista_actual;

  return (
    <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--borde)", background: "#fff" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            #{caso.case_id} · {motivoLegible(caso.motivo_id, caso.motivo_label)}
          </div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>
            Ruta {caso.route_code || "—"} · {hace(caso.fecha_caso)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="pill" style={{ background: pr.bg, color: pr.color }}>{pr.label}</span>
          <span className="pill" style={{ background: est.bg, color: est.color }}>{est.label}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16, background: "var(--fondo)", display: "flex", flexDirection: "column", gap: 10 }}>
        {caso.comentario_cierre && (
          <div style={{ maxWidth: "85%", background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "9px 11px" }}>
            <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 3 }}>Mensaje de MELI al conductor</div>
            <p style={{ fontSize: 13 }}>{caso.comentario_cierre}</p>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12, color: "var(--texto-suave)", marginTop: 4 }}>
          {caso.shipment_id && <span>Envío {caso.shipment_id}</span>}
          {caso.promesa_fecha && <span>Promesa {caso.promesa_fecha} {caso.promesa_estado ? `· ${caso.promesa_estado}` : ""}</span>}
          {caso.tipo_operacion && <span>Operación {caso.tipo_operacion}</span>}
        </div>

        {sinDueno && (
          <div style={{ marginTop: "auto", alignSelf: "center", fontSize: 12, color: "var(--texto-suave)", textAlign: "center", padding: 16 }}>
            Este ticket no tiene analista asignado. Tómalo para empezar a atenderlo.
          </div>
        )}
      </div>

      <div style={{ padding: "11px 16px", borderTop: "1px solid var(--borde)", display: "flex", gap: 8, alignItems: "center" }}>
        {sinDueno ? (
          <button className="btn-navy" onClick={() => onTomar(caso)} style={{ padding: "9px 18px" }}>
            Tomar ticket
          </button>
        ) : esMio ? (
          <>
            <input placeholder="Responder al conductor por WhatsApp…" style={{ flex: 1 }} disabled
              title="La mensajería se conecta en el siguiente paso" />
            <button className="btn-naranja" onClick={() => onResolver(caso)} style={{ padding: "9px 18px", whiteSpace: "nowrap" }}>
              Resolver
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
            Atendido por otro analista. Puedes tomarlo para reasignártelo.
            <button onClick={() => onTomar(caso)} style={{ marginLeft: 10, padding: "5px 12px", fontSize: 12 }}>
              Tomar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
