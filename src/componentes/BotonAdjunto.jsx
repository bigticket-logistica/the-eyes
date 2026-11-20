import { useRef, useState, useEffect } from "react";
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

// ── Imágenes que llegan pegadas o arrastradas ───────────────────────────────
//   WhatsApp acepta solo JPG o PNG de hasta 5 MB. Una captura de dos monitores
//   en PNG puede pasar de eso, y una imagen copiada desde el navegador suele
//   venir en WebP. En vez de rechazarla con un error, se convierte a JPG —y se
//   achica si es enorme— antes de mostrar la vista previa: pegar tiene que
//   funcionar siempre, sin que el analista sepa de formatos.
const LIMITE_IMAGEN = 4.5 * 1024 * 1024;      // margen bajo los 5 MB de Meta
const LADO_MAX = 2560;

async function normalizarImagen(file) {
  const tipo = (file.type || "").toLowerCase();
  const aceptado = tipo === "image/jpeg" || tipo === "image/png";
  if (aceptado && file.size <= LIMITE_IMAGEN) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * escala), h = Math.round(bitmap.height * escala);
    const lienzo = document.createElement("canvas");
    lienzo.width = w; lienzo.height = h;
    const ctx = lienzo.getContext("2d");
    ctx.fillStyle = "#fff";                     // un PNG transparente no queda negro
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => lienzo.toBlob(r, "image/jpeg", 0.88));
    if (!blob) return file;
    const nombre = (file.name || "captura").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], nombre, { type: "image/jpeg" });
  } catch {
    return file;                                // si no se puede convertir, que valide como venga
  }
}

// archivoExterno: un archivo que no vino del selector —pegado con Ctrl+V o
// arrastrado sobre el compositor—. Entra por el mismo camino que uno elegido:
// validación, vista previa, texto opcional y Enviar.
export default function BotonAdjunto({ telefono, caseId, conversacionId, disabled, onEnviado,
                                       archivoExterno, onExternoTomado }) {
  const inputRef = useRef(null);
  const [pendiente, setPendiente] = useState(null);   // { file, tipo, preview }
  const [caption, setCaption] = useState("");
  const [estado, setEstado] = useState(null);         // null | "subiendo" | error

  function elegir(e) {
    const file = e.target.files?.[0];
    e.target.value = "";                              // permite reelegir el mismo archivo
    if (!file) return;
    tomar(file);
  }

  // Un solo camino para el archivo, venga de donde venga.
  async function tomar(original) {
    const file = (original.type || "").startsWith("image/")
      ? await normalizarImagen(original)
      : original;
    const problema = validarAdjunto(file);
    if (problema) { setEstado(problema); return; }
    setEstado(null);
    const tipo = tipoDeArchivo(file);
    setPendiente({
      file, tipo,
      preview: tipo === "image" ? URL.createObjectURL(file) : null,
    });
  }

  useEffect(() => {
    if (!archivoExterno) return;
    if (!disabled) tomar(archivoExterno);
    onExternoTomado?.();
    // tomar no cambia entre renders de forma que importe acá
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archivoExterno]);

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
                  <input value={caption} onChange={(e) => setCaption(e.target.value)} autoFocus
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
