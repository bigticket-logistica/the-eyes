import { useState, useEffect, useRef, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { puedeActuar } from "../shared/permisos.js";
import { detalleEstado, estiloPrioridad, motivoLegible, ESTADOS_ABIERTOS } from "../shared/constantes.js";
import { hace, fechaHora } from "../shared/fechas.js";
import { mensajesDelCaso, conversacionPorTelefono, ventanaAbierta, enviarMensaje, hayAdjuntoMadurando } from "../shared/mensajes.js";
import Burbuja from "./Burbuja.jsx";
import BotonCompartirChat from "./BotonCompartirChat.jsx";
import BotonAdjunto from "./BotonAdjunto.jsx";
import SelectorEmoji from "./SelectorEmoji.jsx";
import BotonLlamar from "./BotonLlamar.jsx";
import CerrarConMotivo from "./CerrarConMotivo.jsx";
import GrabadorAudio from "./GrabadorAudio.jsx";

export default function HiloTicket({ caso, onTomar, onResolver, onTraspasar, analistaId, nombres }) {
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

  // Respaldo del Realtime mientras un adjunto se descarga o se transcribe.
  useEffect(() => {
    if (!hayAdjuntoMadurando(mensajes)) return;
    const t = setInterval(cargarHilo, 5000);
    return () => clearInterval(t);
  }, [mensajes, cargarHilo]);

  // Realtime: escuchar mensajes nuevos de este caso y mostrarlos al instante
  useEffect(() => {
    if (!caso?.case_id) return;
    const canal = sb
      .channel(`mensajes-caso-${caso.case_id}`)
      .on(
        "postgres_changes",
        // event:"*": los adjuntos maduran por UPDATE (el worker pone media_path
        // y luego la transcripción). Con solo INSERT, la foto no aparecía hasta
        // refrescar la página.
        { event: "*", schema: "public", table: "crm_inc_mensajes", filter: `case_id=eq.${caso.case_id}` },
        (payload) => {
          const nuevo = payload.new;
          if (!nuevo?.id) return;
          setMensajes((prev) => {
            const i = prev.findIndex((m) => m.id === nuevo.id);
            if (i === -1) return [...prev, nuevo];              // INSERT
            const copia = [...prev]; copia[i] = { ...copia[i], ...nuevo }; // UPDATE
            return copia;
          });
        },
      )
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [caso?.case_id]);

  // respaldo: refrescar cada 30s por si Realtime se cae (red, etc.)
  useEffect(() => {
    if (!caso?.case_id) return;
    const t = setInterval(cargarHilo, 30000);
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
  const cerrado = !ESTADOS_ABIERTOS.includes(caso.estado_id);
  const esMio = caso.analista_actual && caso.analista_actual === analistaId;
  const sinDueno = !caso.analista_actual && !cerrado;
  const deOtro = !!caso.analista_actual && caso.analista_actual !== analistaId;
  const ventana = ventanaAbierta(conversacion);

  async function handleEnviar() {
    const t = texto.trim();
    if (!t || enviando) return;
    if (!caso.conductor_telefono) { setError("Este caso no tiene teléfono del conductor"); return; }
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, borderRight: "1px solid var(--borde)", background: "#fff" }}>
      <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--borde)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            #{caso.case_id} · {motivoLegible(caso.motivo_id, caso.motivo_label)}
          </div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>
            Ruta {caso.route_code || "—"} · {caso.conductor_nombre || "sin conductor"} · {hace(caso.fecha_caso)}{caso.analista_actual ? <span style={{ color: "var(--naranja)", fontWeight: 600 }}> · 👤 {(nombres && nombres[caso.analista_actual]) || "analista"}</span> : null}{caso.conductor_telefono_meli && caso.conductor_telefono_meli !== caso.conductor_telefono ? <span style={{ color: "var(--texto-tenue)" }}> · ↩ consulta anidada</span> : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <BotonCompartirChat caso={caso} analistaId={analistaId} compacto />
          <span className="pill" style={{ background: pr.bg, color: pr.color }}>{pr.label}</span>
          <span className="pill" style={{ background: est.bg, color: est.color }}>{est.label}</span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, background: "var(--fondo)", display: "flex", flexDirection: "column", gap: 8 }}>
        {caso.comentario_cierre && (
          <div style={{ maxWidth: "85%", background: "#FFF7ED", border: "1px solid #fed7aa", borderRadius: 10, padding: "9px 11px", alignSelf: "center" }}>
            <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 3 }}>Mensaje de MELI</div>
            <p style={{ fontSize: 13 }}>{caso.comentario_cierre}</p>
          </div>
        )}

        {mensajes.length === 0 ? (
          <div style={{ margin: "auto", fontSize: 12, color: "var(--texto-tenue)", textAlign: "center" }}>
            Sin mensajes todavía.<br />Escribe abajo para contactar al conductor.
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
        {cerrado ? (
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "#ecfdf3", borderTop: "2px solid #16a34a", color: "#15803d", fontSize: 13, fontWeight: 600 }}>
            ✓ Caso resuelto y cerrado · {est.label}
          </div>
        ) : (
          <>
            {!ventana && conversacion && esMio && (
              <div style={{ padding: "6px 16px", fontSize: 11, color: "#92722a", background: "#fffbeb" }}>
                Ventana de 24h cerrada. El conductor debe escribir primero, o se requiere una plantilla.
              </div>
            )}
            <div style={{ padding: "11px 16px", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              {sinDueno ? (
                <button className="btn-navy" onClick={() => onTomar(caso)} style={{ padding: "9px 18px" }}>
                  Tomar ticket
                </button>
              ) : esMio ? (
                <>
                  <BotonAdjunto telefono={caso.conductor_telefono} caseId={caso.case_id}
                    conversacionId={conversacion?.id} disabled={enviando || deOtro}
                    onEnviado={cargarHilo} />
                  <GrabadorAudio telefono={caso.conductor_telefono} caseId={caso.case_id}
                    conversacionId={conversacion?.id} disabled={enviando || deOtro}
                    onEnviado={cargarHilo} />
                  <SelectorEmoji disabled={enviando || deOtro}
                    onElegir={(e) => setTexto((t) => t + e)} />
                  <BotonLlamar telefono={caso.conductor_telefono}
                    nombre={caso.conductor_nombre} disabled={deOtro} />
                  {/* textarea en vez de input: los mensajes a un conductor suelen
                      llevar dirección, referencia y varias líneas, y en un campo
                      de una sola línea no se alcanza a revisar lo escrito */}
                  <textarea
                    value={texto}
                    rows={2}
                    onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleEnviar(); } }}
                    placeholder={deOtro ? `Ticket de ${(nombres && nombres[caso.analista_actual]) || "otro analista"} — tómalo para escribir` : (caso.conductor_telefono ? "Escribe al conductor…  (Enter envía · Shift+Enter salta línea)" : "Sin teléfono del conductor")}
                    disabled={enviando || !caso.conductor_telefono || deOtro}
                    style={{
                      flex: 1, minWidth: 200, fontFamily: "inherit", fontSize: 13,
                      padding: "9px 12px", border: "1px solid var(--borde)",
                      borderRadius: 9, resize: "vertical", lineHeight: 1.45,
                    }}
                  />
                  <button className="btn-navy" onClick={handleEnviar} disabled={enviando || !texto.trim() || !caso.conductor_telefono || deOtro}
                    style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>
                    {enviando ? "Enviando…" : "Enviar"}
                  </button>
                  <CerrarConMotivo caso={caso} onCerrar={onResolver} />
                  {onTraspasar && (
                    <select defaultValue="" onChange={(e) => { const d = e.target.value; e.target.value = ""; if (d) onTraspasar(caso, d); }}
                      title="Traspasar este ticket a otro analista"
                      style={{ fontSize: 12, padding: "8px 6px", border: "1px solid var(--borde)", borderRadius: 7, maxWidth: 130 }}>
                      <option value="" disabled>↪ Traspasar…</option>
                      {Object.entries(nombres || {}).filter(([id]) => id !== analistaId)
                        .map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                    </select>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
                  Atendido por {(nombres && nombres[caso.analista_actual]) || "otro analista"}.
                  <button onClick={() => onTomar(caso)} style={{ marginLeft: 10, padding: "5px 12px", fontSize: 12 }}>
                    Tomar
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
