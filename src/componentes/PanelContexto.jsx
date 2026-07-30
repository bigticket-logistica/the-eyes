import { useEffect, useState } from "react";
import { traerDetalleCaso, cacheFresco, detalleDesdeCache } from "../shared/detalle.js";
import { sb } from "../shared/supabase.js";
import { conversacionPorTelefono, ventanaAbierta, enviarMensaje, enviarCorreoCliente } from "../shared/mensajes.js";

const PLANTILLA_WA = { nombre: "contacto_ruta_torre", idioma: "es_MX" };

// ── Modal genérico compacto ────────────────────────────────────────────────
function Modal({ titulo, sub, children, onCerrar, acciones, ancho = 460 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 60,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onCerrar}>
      <div style={{ background: "#fff", borderRadius: 12, width: ancho, maxWidth: "100%", padding: 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{titulo}</div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>
        {sub && <div style={{ fontSize: 12, color: "var(--texto-suave)", marginBottom: 12 }}>{sub}</div>}
        {children}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>{acciones}</div>
      </div>
    </div>
  );
}

// ── Pasar los datos del comprador al chofer por WhatsApp ───────────────────
function PanelPasarChofer({ caso, comp, dir, numero, onCerrar, analistaId }) {
  const lineas = [
    `Datos para tu entrega del paquete ${caso.shipment_id || caso.case_id}:`,
    comp?.nombre ? `Cliente: ${comp.nombre}` : null,
    `Teléfono: ${numero}`,
    dir ? `Dirección: ${[dir.calle, dir.numero].filter(Boolean).join(" ")}${dir.barrio ? ", " + dir.barrio : ""}${dir.ciudad ? ", " + dir.ciudad : ""}` : null,
    dir?.referencia ? `Referencia: ${dir.referencia}` : null,
  ].filter(Boolean);
  const [texto, setTexto] = useState(lineas.join("\n"));
  const [ventana, setVentana] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [forzarTexto, setForzarTexto] = useState(false);

  useEffect(() => {
    let vivo = true;
    if (!caso.conductor_telefono) { setVentana(false); return; }
    conversacionPorTelefono(caso.conductor_telefono)
      .then((c) => { if (vivo) setVentana(ventanaAbierta(c)); })
      .catch(() => { if (vivo) setVentana(false); });
    return () => { vivo = false; };
  }, [caso.conductor_telefono]);

  const conPlantilla = ventana === false && !forzarTexto;
  const primerNombre = (caso.conductor_nombre || "").split(" ")[0] || "conductor";
  const rutaTxt = caso.route_code || String(caso.case_id);

  async function enviar() {
    if (ocupado || !caso.conductor_telefono) return;
    setOcupado(true); setError("");
    try {
      await enviarMensaje({
        telefono: caso.conductor_telefono,
        texto: conPlantilla
          ? `Hola ${primerNombre}, te contactamos de la torre de soporte Bigticket por tu ruta ${rutaTxt}. ${texto.trim()} Por favor respóndenos por aquí para poder ayudarte.`
          : texto.trim(),
        caseId: caso.case_id,
        emisorId: analistaId,
        plantilla: conPlantilla ? { ...PLANTILLA_WA, variables: [primerNombre, rutaTxt, texto.trim()] } : null,
      });
      setOk("Datos enviados al chofer ✓");
      setTimeout(onCerrar, 1200);
    } catch (e) { setError(e.message || "No se pudo enviar"); setOcupado(false); }
  }

  return (
    <Modal titulo="📤 Pasar datos al chofer"
      sub={`${caso.conductor_nombre || "Conductor"} · ${caso.conductor_telefono || "sin teléfono"}`}
      onCerrar={onCerrar}
      acciones={<>
        <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
        <button onClick={enviar} disabled={ocupado || ventana === null || !caso.conductor_telefono}
          style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff",
            border: "none", borderRadius: 7, cursor: "pointer", opacity: ocupado ? 0.6 : 1 }}>
          {ocupado ? "Enviando…" : conPlantilla ? "Enviar por plantilla" : "Enviar WhatsApp"}
        </button>
      </>}>
      {!caso.conductor_telefono && (
        <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 8 }}>
          Este caso no tiene teléfono del conductor. Tómalo y elige un número, o agrégalo en Directorio.
        </div>
      )}
      <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={6}
        style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10,
          border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ fontSize: 11, color: "var(--texto-suave)", marginTop: 6 }}>
        {ventana === null ? "Verificando conversación…"
          : ventana ? "✓ Conversación abierta: va como mensaje normal."
          : forzarTexto ? "Se enviará como texto normal (si Meta lo rechaza, desmarca la casilla)."
          : "Sin conversación en 24h: va por plantilla aprobada de Meta."}
      </div>
      {ventana === false && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, marginTop: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={forzarTexto} onChange={(e) => setForzarTexto(e.target.checked)} />
          El conductor ya escribió: enviar como texto normal
        </label>
      )}
      {error && <div style={{ color: "#791F1F", fontSize: 12, marginTop: 8 }}>{error}</div>}
      {ok && <div style={{ color: "#166534", fontSize: 12, marginTop: 8 }}>{ok}</div>}
    </Modal>
  );
}

// ── Correo al comprador ────────────────────────────────────────────────────
const PLANTILLAS_CORREO = [
  { id: "referencias", label: "Pedir referencias del domicilio",
    cuerpo: (c) => `Hola ${c.nombre || ""},\n\nTe escribimos de la torre de soporte de Bigticket, transportista de tu pedido de MercadoLibre.\n\nNuestro repartidor no pudo completar la entrega en la dirección registrada. Para lograrlo en el siguiente intento, ¿podrías confirmarnos referencias del domicilio (color de fachada, entre qué calles, algún punto cercano) y un horario en el que haya alguien para recibir?\n\nGracias por tu ayuda.` },
  { id: "confirmar_direccion", label: "Confirmar dirección correcta",
    cuerpo: (c) => `Hola ${c.nombre || ""},\n\nTe escribimos de la torre de soporte de Bigticket, transportista de tu pedido de MercadoLibre.\n\nLa dirección registrada para la entrega presenta una inconsistencia. ¿Podrías confirmarnos la dirección completa (calle, número, colonia, código postal) para reprogramar la entrega correctamente?\n\nGracias.` },
  { id: "horario", label: "Coordinar horario de entrega",
    cuerpo: (c) => `Hola ${c.nombre || ""},\n\nTe escribimos de la torre de soporte de Bigticket, transportista de tu pedido de MercadoLibre.\n\nHemos intentado entregar tu paquete sin encontrar a alguien en el domicilio. ¿En qué rango de horario podríamos encontrarte? También puedes indicarnos si autorizas la entrega a otra persona en la dirección.\n\nGracias.` },
  { id: "libre", label: "Escribir desde cero", cuerpo: () => "" },
];

function PanelCorreo({ caso, comp, onCerrar, onEnviado }) {
  const [plantilla, setPlantilla] = useState("referencias");
  const [destinatario, setDestinatario] = useState(comp?.mail || "");
  const paquete = caso.shipment_id || caso.case_id;
  const [asunto, setAsunto] = useState(`Entrega de tu pedido · Paquete ${paquete}`);
  const [cuerpo, setCuerpo] = useState(PLANTILLAS_CORREO[0].cuerpo(comp || {}));
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  function cambiarPlantilla(id) {
    setPlantilla(id);
    const p = PLANTILLAS_CORREO.find((x) => x.id === id);
    if (p) setCuerpo(p.cuerpo(comp || {}));
  }

  async function enviar() {
    if (ocupado) return;
    setOcupado(true); setError("");
    try {
      await enviarCorreoCliente({
        caseId: caso.case_id, casoId: caso.id,
        destinatario: destinatario.trim(), asunto, cuerpo, plantilla,
      });
      setOk("Correo enviado ✓");
      onEnviado && onEnviado();
      setTimeout(onCerrar, 1200);
    } catch (e) { setError(e.message || "No se pudo enviar"); setOcupado(false); }
  }

  return (
    <Modal titulo="✉️ Correo al comprador" ancho={560}
      sub={`Paquete ${paquete} · sale desde la torre de control`}
      onCerrar={onCerrar}
      acciones={<>
        <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
        <button onClick={enviar} disabled={ocupado || !destinatario.trim() || !cuerpo.trim()}
          style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff",
            border: "none", borderRadius: 7, cursor: "pointer", opacity: ocupado ? 0.6 : 1 }}>
          {ocupado ? "Enviando…" : "Enviar correo"}
        </button>
      </>}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        {PLANTILLAS_CORREO.map((p) => (
          <button key={p.id} onClick={() => cambiarPlantilla(p.id)}
            style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 14, cursor: "pointer",
              border: `1px solid ${plantilla === p.id ? "var(--naranja)" : "var(--borde)"}`,
              background: plantilla === p.id ? "var(--naranja-suave)" : "#fff" }}>{p.label}</button>
        ))}
      </div>
      <input value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="correo@cliente.com"
        style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
          border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 8 }} />
      <input value={asunto} onChange={(e) => setAsunto(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
          border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 8 }} />
      <textarea value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} rows={10}
        style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: 10,
          border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
      {error && <div style={{ color: "#791F1F", fontSize: 12, marginTop: 8 }}>{error}</div>}
      {ok && <div style={{ color: "#166534", fontSize: 12, marginTop: 8 }}>{ok}</div>}
    </Modal>
  );
}

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

export default function PanelContexto({ caso, analistaId }) {
  const [modalChofer, setModalChofer] = useState(null);   // número elegido
  const [modalCorreo, setModalCorreo] = useState(false);
  const [correosEnviados, setCorreosEnviados] = useState(0);
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

  useEffect(() => {
    if (!caso?.case_id) { setCorreosEnviados(0); return; }
    let vivo = true;
    sb.from("crm_inc_correos").select("id", { count: "exact", head: true })
      .eq("case_id", caso.case_id)
      .then(({ count }) => { if (vivo) setCorreosEnviados(count || 0); });
    return () => { vivo = false; };
  }, [caso?.case_id, modalCorreo]);

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
                  onClick={() => setModalChofer(t.numero)}
                  title="Envía por WhatsApp los datos del comprador al chofer">
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

      {/* ─── CORREO AL COMPRADOR ─── */}
      <div style={SEP}>
        <Titulo>Correo al comprador</Titulo>
        {comp.mail ? (
          <>
            <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 6 }}>{comp.mail}</div>
            <button className="btn-navy" style={{ width: "100%", padding: "8px", fontSize: 12 }}
              onClick={() => setModalCorreo(true)}
              title="Redactar y enviar un correo al comprador desde la torre">
              ✉️ Escribir correo
            </button>
            {correosEnviados > 0 && (
              <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 5, textAlign: "center" }}>
                {correosEnviados} {correosEnviados === 1 ? "correo enviado" : "correos enviados"} en este ticket
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
            {cargando ? "Cargando…" : "Sin correo del comprador en este caso."}
          </div>
        )}
      </div>

      {/* ─── QUIÉN RECIBIÓ ─── */}
      {hayRecibio && (
        <div style={SEP}>
          <Titulo>Quién recibió</Titulo>
          <div style={{ fontSize: 12 }}>
            {qr.nombre || "—"}{qr.tipo ? <span style={{ color: "var(--texto-suave)" }}> · {qr.tipo}</span> : ""}
          </div>
        </div>
      )}

      {modalChofer && (
        <PanelPasarChofer caso={caso} comp={comp} dir={dir} numero={modalChofer}
          analistaId={analistaId} onCerrar={() => setModalChofer(null)} />
      )}
      {modalCorreo && (
        <PanelCorreo caso={caso} comp={comp} onCerrar={() => setModalCorreo(false)} />
      )}
    </div>
  );
}
