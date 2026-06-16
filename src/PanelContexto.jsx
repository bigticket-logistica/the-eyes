function iniciales(n) {
  if (!n) return "··";
  return n.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function Fila({ etiqueta, valor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "var(--texto-suave)" }}>{etiqueta}</span>
      <span style={{ textAlign: "right" }}>{valor ?? "—"}</span>
    </div>
  );
}

export default function PanelContexto({ caso }) {
  if (!caso) return <div style={{ background: "#fff" }} />;

  const compradorVivo = !caso.comprador_purgado && (caso.comprador_telefono || caso.comprador_nombre);

  return (
    <div style={{ overflowY: "auto", background: "#fff", padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)", marginBottom: 8 }}>Conductor</div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%", background: "var(--navy)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 500, fontSize: 12,
        }}>{iniciales(caso.conductor_nombre)}</div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{caso.conductor_nombre || "Sin resolver"}</div>
          <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
            {caso.patente || "—"}{caso.vehiculo ? ` · ${caso.vehiculo}` : ""}
          </div>
        </div>
      </div>
      {caso.conductor_telefono && (
        <a href={`tel:${caso.conductor_telefono}`} style={{ fontSize: 12, color: "var(--navy)", textDecoration: "none" }}>
          {caso.conductor_telefono}
        </a>
      )}

      <div style={{ borderTop: "1px solid var(--borde)", marginTop: 10, paddingTop: 10 }}>
        <Fila etiqueta="SC" valor={caso.estacion_origen} />
        <Fila etiqueta="Avance ruta" valor={caso.route_progress != null ? `${caso.route_progress}%` : null} />
        <Fila etiqueta="Entregados" valor={caso.entregados != null ? `${caso.entregados}/${caso.paquetes_en_ruta ?? "—"}` : null} />
        <Fila etiqueta="Horas en ruta" valor={caso.horas_en_ruta} />
        <Fila etiqueta="Con auxiliar" valor={caso.con_auxiliar == null ? null : caso.con_auxiliar ? "Sí" : "No"} />
      </div>

      <div style={{ borderTop: "1px solid var(--borde)", marginTop: 10, paddingTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)", marginBottom: 8 }}>
          Comprador {compradorVivo && <span style={{ color: "#bb8200", fontWeight: 400 }}>· efímero</span>}
        </div>
        {compradorVivo ? (
          <>
            <div style={{ fontSize: 12 }}>{caso.comprador_nombre || "—"}</div>
            {caso.comprador_direccion && (
              <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>{caso.comprador_direccion}</div>
            )}
            {caso.comprador_telefono && (
              <button className="btn-navy" style={{ width: "100%", marginTop: 8, padding: "8px", fontSize: 12 }}
                title="Envía el número al chofer para que coordine la entrega">
                Pasar número al chofer
              </button>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>
            {caso.comprador_purgado ? "Contacto eliminado al resolver el caso" : "Sin datos de comprador"}
          </div>
        )}
      </div>
    </div>
  );
}
