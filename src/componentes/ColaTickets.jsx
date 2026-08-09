import { useState } from "react";
import { estiloPrioridad, motivoLegible, detalleEstado } from "../shared/constantes.js";
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

function Tarjeta({ c, seleccionado, onSeleccionar, analistaId, colorBorde, apagado, nombres }) {
  const activo = seleccionado?.id === c.id;
  const mio = c.analista_actual && c.analista_actual === analistaId;
  const est = detalleEstado(c.estado_id, c.sub_estado_id);
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
        {!apagado && !mio && c.analista_actual && (
          <span style={{ fontSize: 10.5, color: "var(--texto-suave)", marginLeft: "auto" }}>
            👤 {((nombres && nombres[c.analista_actual]) || "analista").split(" ")[0]}
          </span>
        )}
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

export default function ColaTickets({ casosHoy = [], cerradosHoy = [], seleccionado, onSeleccionar, analistaId, nombres, consultasLibres = [], onAnidar, totalHoy }) {
  const [busqueda, setBusqueda] = useState("");

  // Se busca por número de incidencia, nombre del conductor, ruta o SC: el
  // analista a veces tiene el número y a veces solo el nombre de quien llamó.
  const coincide = (c) => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return true;
    const soloDigitos = q.replace(/\D/g, "");
    return (
      (soloDigitos && String(c.case_id || "").includes(soloDigitos)) ||
      String(c.codigo || "").toLowerCase().includes(q) ||
      String(c.conductor_nombre || "").toLowerCase().includes(q) ||
      String(c.route_code || "").toLowerCase().includes(q) ||
      String(c.estacion_origen || "").toLowerCase().includes(q) ||
      String(c.motivo_label || c.motivo_id || "").toLowerCase().includes(q) ||
      String(c.shipment_id || "").includes(soloDigitos)
    );
  };

  const filtrados = busqueda.trim() ? casosHoy.filter(coincide) : casosHoy;
  const cerradosFiltrados = busqueda.trim() ? cerradosHoy.filter(coincide) : cerradosHoy;
  const hayBusqueda = busqueda.trim().length > 0;
  const encontrados = filtrados.length + cerradosFiltrados.length;

  const { rejas, presentes } = agruparPorReja(filtrados);
  const total = casosHoy.length + cerradosHoy.length;

  // cerrados de hoy: mas reciente primero
  const cerrados = [...cerradosFiltrados].sort((a, b) => new Date(b.fecha_caso) - new Date(a.fecha_caso));

  return (
    <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
      <div style={{
        padding: "11px 14px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, background: "#fff", zIndex: 2,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Cola de hoy</div>
          <div style={{ fontSize: 11, color: "var(--texto-suave)", marginTop: 2 }}>
            {casosHoy.length} {casosHoy.length === 1 ? "abierto" : "abiertos"} · {cerradosHoy.length} sin gestión pendiente
          </div>
        </div>
        <span style={{ fontSize: 20, fontWeight: 700, color: "var(--navy)" }}
          title="Total de incidencias del día">
          {(totalHoy ?? (casosHoy.length + cerradosHoy.length))}
        </span>
      </div>

      {/* Buscador: con más de doscientas incidencias al día, encontrar una por
          scroll es inviable. Busca por número, conductor, ruta, SC o motivo. */}
      <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--borde)",
        position: "sticky", top: 52, background: "#fff", zIndex: 2 }}>
        <div style={{ position: "relative" }}>
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar #, conductor, ruta, SC…"
            style={{ fontSize: 12, padding: "6px 26px 6px 10px" }} />
          {hayBusqueda && (
            <button onClick={() => setBusqueda("")}
              title="Limpiar"
              style={{
                position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                border: "none", background: "transparent", fontSize: 13,
                color: "var(--texto-tenue)", padding: "2px 5px", lineHeight: 1,
              }}>✕</button>
          )}
        </div>
        {hayBusqueda && (
          <div style={{ fontSize: 10.5, color: encontrados ? "var(--texto-suave)" : "#b45309",
            marginTop: 5 }}>
            {encontrados === 0
              ? "Sin coincidencias en las incidencias de hoy"
              : `${encontrados} de ${casosHoy.length + cerradosHoy.length}`}
          </div>
        )}
      </div>

      {/* ANIDAR CONSULTA: une un ticket de Consultas en ruta a esta incidencia */}
      {onAnidar && (
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--borde)", background: "#fafbfc" }}>
          <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 5 }}>
            ↩ Anidar consulta en la incidencia seleccionada
          </div>
          {(() => {
            const mia = seleccionado && seleccionado.analista_actual && seleccionado.analista_actual === analistaId;
            if (!seleccionado) return <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>Elige una incidencia primero.</div>;
            if (!mia) return <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>Toma la incidencia para poder anidar.</div>;

            // Solo se ofrecen consultas del MISMO teléfono que la incidencia.
            // Antes se listaban todas, así que era posible anidar la consulta de
            // un conductor en la incidencia de otro: dos hilos de WhatsApp
            // distintos mezclados en un ticket, con los mensajes de una persona
            // apareciendo en el caso de otra.
            const tel10 = (t) => String(t || "").replace(/\D/g, "").slice(-10);
            const delMismo = consultasLibres.filter(
              (c) => tel10(c.conductor_telefono) &&
                     tel10(c.conductor_telefono) === tel10(seleccionado.conductor_telefono));

            if (!seleccionado.conductor_telefono) {
              return <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
                Esta incidencia no tiene teléfono del conductor, no se puede anidar.
              </div>;
            }
            if (!delMismo.length) {
              return <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
                Sin consultas abiertas de este conductor
                {consultasLibres.length > 0 && ` (hay ${consultasLibres.length} de otros números)`}.
              </div>;
            }
            return (
              <select defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) onAnidar(seleccionado, v); }}
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--borde)", borderRadius: 7 }}>
                <option value="" disabled>Elegir consulta… ({delMismo.length})</option>
                {delMismo.map((c) => (
                  <option key={c.case_id} value={c.case_id}>
                    {(c.codigo || "#" + c.case_id) + " · " + (c.conductor_nombre || c.conductor_telefono || "sin nombre")}
                  </option>
                ))}
              </select>
            );
          })()}
        </div>
      )}

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
                onSeleccionar={onSeleccionar} analistaId={analistaId} nombres={nombres} colorBorde={pr.color} />
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
              onSeleccionar={onSeleccionar} analistaId={analistaId} nombres={nombres} colorBorde="#d1d5db" apagado />
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
