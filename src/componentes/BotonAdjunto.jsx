import { useRef, useState } from "react";
import { enviarAdjunto, validarAdjunto, tipoDeArchivo } from "../shared/mensajes.js";

// ═══════════════════════════════════════════════════════════════════════════
// Botón 📎 del compositor. Sube el archivo al bucket privado y lo manda por
// WhatsApp vía la Edge Function whatsapp-media.
//
// Valida ANTES de subir: si el archivo excede el límite de Meta o tiene un
// formato que WhatsApp rechaza (un .wav como audio, por ejemplo), se dice al
// instante en vez de gastar la subida para recibir un 400 después.
// ═══════════════════════════════════════════════════════════════════════════

const ICONO = { image: "🖼", audio: "🎧", video: "🎬", document: "📄" };

export default function BotonAdjunto({ telefono, caseId, conversacionId, disabled, onEnviado }) {
  const inputRef = useRef(null);
  const [pendiente, setPendiente] = useState(null);   // { file, tipo, preview }
  const [caption, setCaption] = useState("");
  const [estado, setEstado] = useState(null);         // null | "subiendo" | error

  function elegir(e) {
    const file = e.target.files?.[0];
    e.target.value = "";                              // permite reelegir el mismo archivo
    if (!file) return;
    const problema = validarAdjunto(file);
    if (problema) { setEstado(problema); return; }
    setEstado(null);
    const tipo = tipoDeArchivo(file);
    setPendiente({
      file, tipo,
      preview: tipo === "image" ? URL.createObjectURL(file) : null,
    });
  }

  function cancelar() {
    if (pendiente?.preview) URL.revokeObjectURL(pendiente.preview);
    setPendiente(null); setCaption(""); setEstado(null);
  }

  async function enviar() {
    if (!pendiente || estado === "subiendo") return;
    setEstado("subiendo");
    try {
      await enviarAdjunto({
        file: pendiente.file, telefono, caseId, conversacionId,
        caption: caption.trim() || null,
      });
      cancelar();
      onEnviado?.();
    } catch (err) {
      setEstado(err.message);
    }
  }

  if (!telefono) return null;

  return (
    <>
      <input ref={inputRef} type="file" onChange={elegir} style={{ display: "none" }}
        accept="image/jpeg,image/png,audio/*,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx" />
      <button onClick={() => inputRef.current?.click()} disabled={disabled}
        title="Enviar imagen, audio o documento al conductor"
        style={{ padding: "9px 12px", fontSize: 15, lineHeight: 1 }}>
        📎
      </button>

      {(pendiente || (estado && estado !== "subiendo")) && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }} onClick={(e) => { if (e.target === e.currentTarget) cancelar(); }}>
          <div style={{
            background: "#fff", borderRadius: 12, padding: 18, width: 380, maxWidth: "92vw",
            boxShadow: "0 12px 40px rgba(0,0,0,.25)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              Enviar al conductor
            </div>

            {pendiente ? (
              <>
                {pendiente.preview ? (
                  <img src={pendiente.preview} alt="Vista previa"
                    style={{
                      width: "100%", maxHeight: 220, objectFit: "contain",
                      borderRadius: 8, border: "1px solid var(--borde)", marginBottom: 10,
                    }} />
                ) : (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10, padding: 12, marginBottom: 10,
                    border: "1px solid var(--borde)", borderRadius: 8, background: "#f8fafc",
                  }}>
                    <span style={{ fontSize: 26 }}>{ICONO[pendiente.tipo]}</span>
                    <div style={{ fontSize: 12, overflow: "hidden" }}>
                      <div style={{ fontWeight: 600, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                        {pendiente.file.name}
                      </div>
                      <div style={{ opacity: 0.6 }}>
                        {(pendiente.file.size / 1024).toFixed(0)} KB
                      </div>
                    </div>
                  </div>
                )}

                {pendiente.tipo !== "audio" && (
                  <input value={caption} onChange={(e) => setCaption(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") enviar(); }}
                    placeholder="Mensaje que acompaña (opcional)…"
                    style={{
                      width: "100%", fontSize: 13, padding: "8px 10px", marginBottom: 12,
                      border: "1px solid var(--borde)", borderRadius: 8, boxSizing: "border-box",
                    }} />
                )}
              </>
            ) : null}

            {estado && estado !== "subiendo" && (
              <div style={{
                fontSize: 12, color: "#b91c1c", background: "#fef2f2", padding: "8px 10px",
                borderRadius: 7, marginBottom: 12, border: "1px solid #fca5a5",
              }}>
                {estado}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={cancelar} style={{ padding: "8px 14px", fontSize: 13 }}>Cancelar</button>
              {pendiente && (
                <button className="btn-navy" onClick={enviar} disabled={estado === "subiendo"}
                  style={{ padding: "8px 18px", fontSize: 13 }}>
                  {estado === "subiendo" ? "Enviando…" : "Enviar"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
