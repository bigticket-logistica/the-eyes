import { useState, useEffect, useRef, useCallback } from "react";
import { detalleEstado, estiloPrioridad, motivoLegible } from "../shared/constantes.js";
import { hace, fechaHora } from "../shared/fechas.js";
import { mensajesDelCaso, conversacionPorTelefono, ventanaAbierta, enviarMensaje } from "../shared/mensajes.js";

function Burbuja({ m }) {
  const saliente = m.direccion === "saliente";
  const esIA = m.emisor === "ia";
  const align = saliente ? "flex-end" : "flex-start";
  const bg = saliente ? (esIA ? "#EEF2FF" : "var(--navy)") : "#fff";
  const color = saliente && !esIA ? "#fff" : "var(--texto)";
  return (
    <div style={{ display: "flex", justifyContent: align }}>
      <div style={{
        maxWidth: "78%", background: bg, color,
        border: saliente && !esIA ? "none" : "1px solid var(--borde)",
        borderRadius: 12, padding: "8px 12px",
      }}>
        {saliente && (
          <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>
            {esIA ? "Asistente IA" : "Analista"}
          </div>
        )}
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.tipo_contenido === "texto" ? m.texto : `[${m.tipo_contenido}]${m.texto ? " " + m.texto : ""}`}
        </div>
        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3, textAlign: "right" }}>
          {fechaHora(m.creado_en)}{saliente && m.estado_entrega ? ` \u00b7 ${m.estado_entrega}` : ""}
        </div>
      </div>
    </div>
  );
}

export default function HiloTicket({ caso, onTomar, onResolver, analistaId }) {
  const [mensajes, setMensajes] = useState([]);
  const [conversacion, setConversacion] = useState(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const finRef = useRef(null);

  const cargarHilo = useCallback(async () => {
    if (!caso?.case_id) { setMensajes([]); return; }
    try {
      const msgs = await mensajesDelCaso(caso.case_id);
      setMensajes(msgs);
      if (caso.conductor_telefono) {
        const conv = await conversacionPorTelefono(caso.conductor_telefono);
        setConversacion(conv);
      }
    } catch (e) { setError(e.message); }
  }, [caso?.case_id, caso?.conductor_telefono]);

  useEffect(() => { cargarHilo(); }, [cargarHilo]);

  useEffect(() => {
    if (!caso?.case_id) return;
    const t = setInterval(cargarHilo, 15000);
    return () => clearInterval(t);
  }, [caso?.case_id, cargarHilo]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mensajes.length]);

  if (!caso) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)", borderRight: "1px solid var(--borde)" }}>
        Selecciona un ticket de la cola
      </div>
    );
  }

  const est = detalleEstado(caso.estado_id, caso.sub_estado_id);
  const pr = estiloPrioridad(caso.prioridad);
  const esMio = caso.analista_actual && caso.analista_actual === analistaId;
  const sinDueno = !caso.analista_actual;
  const ventana = ventanaAbierta(conversacion);

  async function handleEnviar() {
    const t = texto.trim();
    if (!t || enviando) return;
    if (!caso.conductor_telefono) { setError("Este caso no tiene tel\u00e9fono del conductor"); return; }
    setEnviando(true); setError(null);
    try {
      await enviarMensaje({
        telefono: caso.conductor_telefono,
        texto: t,
        caseId: caso.case_id,
        emisorId: analistaId,
      });
      setTexto("");
      await cargarHilo();
    } catch (e) {
      setError(e.message || "No se pudo enviar");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--borde)", background: "#fff" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            #{caso.case_id} \u00b7 {motivoLegible(caso.motivo_id, caso.motivo_label)}
          </div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>
            Ruta {caso.route_code || "\u2014"} \u00b7 {caso.conductor_nombre || "sin conductor"} \u00b7 {hace(caso.fecha_caso)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="pill" style={{ background: pr.bg, color: pr.color }}>{pr.label}</span>
          <span className="pill" style={{ background: est.bg, color: est.color }}>{est.label}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16, background: "var(--fondo)", display: "flex", flexDirection: "column", gap: 8 }}>
        {caso.comentario_cierre && (
          <div style={{ maxWidth: "85%", background: "#FFF7ED", border: "1px solid #fed7aa", borderRadius: 10, padding: "9px 11px", alignSelf: "center" }}>
            <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 3 }}>Mensaje de MELI</div>
            <p style={{ fontSize: 13 }}>{caso.comentario_cierre}</p>
          </div>
        )}

        {mensajes.length === 0 ? (
          <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>
            Sin mensajes todav\u00eda.<br />Escribe abajo para contactar al conductor.
          </div>
        ) : (
          mensajes.map((m) => <Burbuja key={m.id} m={m} />)
        )}
        <div ref={finRef} />
      </div>

      <div style={{ borderTop: "1px solid var(--borde)" }}>
        {error && (
          <div style={{ padding: "6px 16px", fontSize: 12, color: "#bb4444", background: "#fff5f5" }}>{error}</div>
        )}
        {!ventana && conversacion && esMio && (
          <div style={{ padding: "6px 16px", fontSize: 11, color: "#92722a", background: "#fffbeb" }}>
            Ventana de 24h cerrada. El conductor debe escribir primero, o se requiere una plantilla.
          </div>
        )}
        <div style={{ padding: "11px 16px", display: "flex", gap: 8, alignItems: "center" }}>
          {sinDueno ? (
            <button className="btn-navy" onClick={() => onTomar(caso)} style={{ padding: "9px 18px" }}>
              Tomar ticket
            </button>
          ) : esMio ? (
            <>
              <input
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleEnviar(); } }}
                placeholder={caso.conductor_telefono ? "Escribe al conductor\u2026" : "Sin tel\u00e9fono del conductor"}
                disabled={enviando || !caso.conductor_telefono}
                style={{ flex: 1 }}
              />
              <button className="btn-navy" onClick={handleEnviar} disabled={enviando || !texto.trim() || !caso.conductor_telefono}
                style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>
                {enviando ? "Enviando\u2026" : "Enviar"}
              </button>
              <button className="btn-naranja" onClick={() => onResolver(caso)} style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>
                Resolver
              </button>
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
              Atendido por otro analista.
              <button onClick={() => onTomar(caso)} style={{ marginLeft: 10, padding: "5px 12px", fontSize: 12 }}>
                Tomar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
