import { useEffect, useState } from "react";
import { traerDetalleCaso, cacheFresco, detalleDesdeCache } from "../shared/detalle.js";

function iniciales(n) {
  if (!n) return "··";
  return n.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function Fila({ etiqueta, valor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12, gap: 10 }}>
      <span style={{ color: "var(--texto-suave)", flexShrink: 0 }}>{etiqueta}</span>
      <span style={{ textAlign: "right" }}>{valor ?? "—"}</span>
    </div>
  );
}

function Titulo({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)", marginBottom: 8, marginTop: 4 }}>
      {children}
    </div>
  );
}

const SEP = { borderTop: "1px solid var(--borde)", marginTop: 12, paddingTop: 12 };

export default function PanelContexto({ caso }) {
  const [detalle, setDetalle] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!caso?.case_id) { setDetalle(null); return; }
    let activo = true;
    setError(null);

    if (cacheFresco(caso)) {
      setDetalle(detalleDesdeCache(caso));
      setCargando(false);
      return;
    }
    if (caso.detalle_actualizado_en) setDetalle(detalleDesdeCache(caso));
    else setDetalle(null);
    setCargando(true);
    traerDetalleCaso(caso.case_id)
      .then((d) => { if (activo) setDetalle(d); })
      .catch((e) => { if (activo) setError(e.message || "No se pudo cargar el detalle"); })
      .finally(() => { if (activo) setCargando(false); });
    return () => { activo = false; };
  }, [caso?.case_id, caso?.detalle_actualizado_en]);

  if (!caso) return <div style={{ background: "#fff" }} />;

  const cond = detalle?.conductor || {};
  const comp = detalle?.comprador || {};
  const met = detalle?.metricas || {};
  const dir = detalle?.direccion || {};
  const qr = detalle?.quien_recibio || {};

  // contactos del comprador: array de {numero, etiqueta}, o el telefono unico
  const contactos = Array.isArray(comp.telefonos) ? comp.telefonos
    : (comp.telefono ? [{ numero: comp.telefono, etiqueta: null }] : []);
  const compradorVivo = !!(comp.nombre || comp.mail || contactos.length);
  const hayDireccion = dir && Object.values(dir).some(Boolean);
  const hayRecibio = qr && (qr.nombre || qr.tipo);

  return (
    <div style={{ overflowY: "auto", background: "#fff", padding: 14 }}>
      {/* ─── CONDUCTOR ─── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--texto-suave)" }}>Conductor</span>
        {cargando && <span style={{ fontSize: 10, color: "var(--texto-tenue)" }}>cargando…</span>}
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: "#bb4444", marginBottom: 10 }}>
          No se pudo cargar el detalle. <span style={{ color: "var(--texto-tenue)" }}>{error}</span>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--navy)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontWeight: 500, fontSize: 12,
            }}>{iniciales(cond.nombre)}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {cond.nombre || (cargando ? "…" : "Sin resolver")}
              </div>
              <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                {cond.patente || "—"}{cond.vehiculo ? ` · ${cond.vehiculo}` : ""}
              </div>
            </div>
          </div>
          {cond.telefono && (
            <a href={`tel:${cond.telefono}`} style={{ fontSize: 12, color: "var(--navy)", textDecoration: "none", display: "block" }}>
              📞 {cond.telefono}
            </a>
          )}
          {cond.mail && (
            <div style={{ fontSize: 11, color: "var(--texto-suave)", marginTop: 2 }}>{cond.mail}</div>
          )}
        </>
      )}

      {/* ─── MÉTRICAS DE RUTA ─── */}
      <div style={SEP}>
        <Fila etiqueta="SC" valor={met.estacion || caso.estacion_origen} />
        <Fila etiqueta="Ruta" valor={met.ruta || caso.route_code} />
        <Fila etiqueta="Avance" valor={met.avance_ruta} />
        <Fila etiqueta="Entregados" valor={met.entregados != null ? `${met.entregados}/${met.paquetes_en_ruta ?? "—"}` : null} />
        <Fila etiqueta="Fallidas" valor={met.fallidas != null ? `${met.fallidas}${met.pct_fallidas ? ` (${met.pct_fallidas})` : ""}` : null} />
        <Fila etiqueta="Horas en ruta" valor={met.horas_en_ruta} />
        <Fila etiqueta="Con auxiliar" valor={cond.con_auxiliar} />
      </div>

      {/* ─── COMPRADOR ─── */}
      <div style={SEP}>
        <Titulo>
          Comprador {compradorVivo && <span style={{ color: "#bb8200", fontWeight: 400 }}>· efímero</span>}
        </Titulo>
        {compradorVivo ? (
          <>
            <div style={{ fontSize: 12 }}>{comp.nombre || "—"}</div>
            {comp.mail && <div style={{ fontSize: 11, color: "var(--texto-suave)", marginTop: 2 }}>{comp.mail}</div>}
            {contactos.map((t, i) => (
              <div key={t.numero + i} style={{ marginTop: 8 }}>
                {t.etiqueta && (
                  <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginBottom: 2 }}>{t.etiqueta}</div>
                )}
                <button className="btn-navy" style={{ width: "100%", padding: "8px", fontSize: 12 }}
                  title="Envía el número al chofer para que coordine la entrega">
                  Pasar al chofer · {t.numero}
                </button>
              </div>
            ))}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>
            {cargando ? "Cargando…" : "Sin datos de comprador"}
          </div>
        )}
      </div>

      {/* ─── DIRECCIÓN DE ENTREGA ─── */}
      {hayDireccion && (
        <div style={SEP}>
          <Titulo>Dirección de entrega</Titulo>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            {[dir.calle, dir.numero].filter(Boolean).join(" ")}
            {dir.barrio ? <div style={{ color: "var(--texto-suave)" }}>{dir.barrio}</div> : null}
            <div style={{ color: "var(--texto-suave)" }}>
              {[dir.ciudad, dir.provincia, dir.cp].filter(Boolean).join(", ")}
            </div>
            {dir.referencia && (
              <div style={{ color: "var(--texto-tenue)", marginTop: 3, fontStyle: "italic" }}>
                Ref: {dir.referencia}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── QUIÉN RECIBIÓ ─── */}
      {hayRecibio && (
        <div style={SEP}>
          <Titulo>Quién recibió</Titulo>
          <div style={{ fontSize: 12 }}>
            {qr.nombre || "—"}{qr.tipo ? <span style={{ color: "var(--texto-suave)" }}> · {qr.tipo}</span> : ""}
          </div>
        </div>
      )}
    </div>
  );
}
