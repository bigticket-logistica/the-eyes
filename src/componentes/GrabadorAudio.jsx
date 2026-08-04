import { useState, useRef, useEffect } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// GRABADOR DE AUDIO · como WhatsApp: 🎤 para grabar, cronómetro, cancelar,
// escuchar antes de enviar.
//
// POR QUÉ NO SE MANDA DIRECTO
//   Chrome graba en audio/webm y WhatsApp NO acepta WebM (solo aac, amr, mp3,
//   m4a y ogg-opus). Así que la grabación sube al bucket cruda y el servicio
//   the-eyes-audio del VPS la convierte con ffmpeg antes de enviarla.
//   Se elige el mejor formato que el navegador soporte, para que la conversión
//   sea lo más liviana posible.
// ═══════════════════════════════════════════════════════════════════════════

const URL_AUDIO = import.meta.env.VITE_AUDIO_URL || "https://voz.bigticket.mx/audio/enviar";
const MAX_SEG = 300;   // 5 minutos; el servidor también lo recorta

// Orden de preferencia: lo que menos conversión necesite.
function mejorFormato() {
  const candidatos = [
    "audio/ogg;codecs=opus",   // Firefox · ya es lo que quiere Meta
    "audio/mp4",               // Safari · Meta lo acepta
    "audio/webm;codecs=opus",  // Chrome · hay que convertir
    "audio/webm",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  return candidatos.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

const reloj = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function GrabadorAudio({ telefono, caseId, conversacionId, disabled, onEnviado }) {
  const [estado, setEstado] = useState("idle");  // idle | grabando | listo | enviando
  const [segundos, setSegundos] = useState(0);
  const [error, setError] = useState(null);
  const [grabacion, setGrabacion] = useState(null);   // { blob, url, mime }

  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  // Cortar el micrófono si el componente se desmonta a mitad de grabación:
  // dejar el stream abierto mantiene el indicador rojo del navegador encendido.
  useEffect(() => () => {
    clearInterval(timerRef.current);
    try { recRef.current?.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ya cerrado */ }
    if (grabacion?.url) URL.revokeObjectURL(grabacion.url);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function empezar() {
    setError(null);
    const mime = mejorFormato();
    if (!mime) { setError("Este navegador no permite grabar audio."); return; }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      setError(e.name === "NotAllowedError"
        ? "Diste permiso denegado al micrófono. Habilítalo en el candado de la barra de direcciones."
        : `No se pudo abrir el micrófono: ${e.message}`);
      return;
    }

    chunksRef.current = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: mime });
      setGrabacion({ blob, url: URL.createObjectURL(blob), mime });
      setEstado("listo");
    };
    rec.start();
    recRef.current = rec;
    setEstado("grabando");
    setSegundos(0);
    timerRef.current = setInterval(() => {
      setSegundos((s) => {
        if (s + 1 >= MAX_SEG) { detener(); return s + 1; }
        return s + 1;
      });
    }, 1000);
  }

  function detener() {
    clearInterval(timerRef.current);
    try { recRef.current?.stop(); } catch { /* ya detenido */ }
  }

  function descartar() {
    clearInterval(timerRef.current);
    try { recRef.current?.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ya cerrado */ }
    if (grabacion?.url) URL.revokeObjectURL(grabacion.url);
    setGrabacion(null); setEstado("idle"); setSegundos(0); setError(null);
  }

  async function enviar() {
    if (!grabacion) return;
    setEstado("enviando"); setError(null);
    try {
      const ext = grabacion.mime.includes("ogg") ? "ogg"
                : grabacion.mime.includes("mp4") ? "m4a" : "webm";
      const f = new Date();
      const ruta = `wa-out/${f.getFullYear()}/${String(f.getMonth() + 1).padStart(2, "0")}/` +
                   `${crypto.randomUUID()}.${ext}`;

      const { error: errUp } = await sb.storage.from("crm-media")
        .upload(ruta, grabacion.blob, { contentType: grabacion.mime, upsert: false });
      if (errUp) throw new Error(`No se pudo subir: ${errUp.message}`);

      const { data: ses } = await sb.auth.getSession();
      const token = ses?.session?.access_token;
      if (!token) throw new Error("Sesión expirada, vuelve a entrar");

      const r = await fetch(URL_AUDIO, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          media_path: ruta, telefono,
          case_id: caseId || null, conversacion_id: conversacionId || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `Error ${r.status}`);

      descartar();
      onEnviado?.();
    } catch (e) {
      setError(e.message);
      setEstado("listo");
    }
  }

  if (!telefono) return null;

  // ── Reposo: solo el botón ─────────────────────────────────────────────────
  if (estado === "idle" && !error) {
    return (
      <button onClick={empezar} disabled={disabled} title="Grabar una nota de voz para el conductor"
        style={{ padding: "9px 12px", fontSize: 15, lineHeight: 1 }}>
        🎤
      </button>
    );
  }

  // ── Grabando ──────────────────────────────────────────────────────────────
  if (estado === "grabando") {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
        border: "1px solid #fca5a5", background: "#fef2f2", borderRadius: 9,
      }}>
        <span style={{
          width: 9, height: 9, borderRadius: "50%", background: "#dc2626",
          animation: "pulso 1s ease-in-out infinite",
        }} />
        <style>{"@keyframes pulso{0%,100%{opacity:1}50%{opacity:.25}}"}</style>
        <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "#b91c1c", minWidth: 34 }}>
          {reloj(segundos)}
        </span>
        <button onClick={descartar} title="Descartar"
          style={{ fontSize: 12, padding: "4px 9px" }}>✕</button>
        <button className="btn-navy" onClick={detener}
          style={{ fontSize: 12, padding: "4px 11px", whiteSpace: "nowrap" }}>Listo</button>
      </div>
    );
  }

  // ── Grabado: escuchar antes de mandar ─────────────────────────────────────
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
      border: "1px solid var(--borde)", background: "#f8fafc", borderRadius: 9,
      flexWrap: "wrap", maxWidth: 420,
    }}>
      {grabacion && <audio controls src={grabacion.url} style={{ height: 32, maxWidth: 190 }} />}
      <button onClick={descartar} disabled={estado === "enviando"}
        title="Descartar y volver a grabar" style={{ fontSize: 12, padding: "5px 9px" }}>
        ✕
      </button>
      <button className="btn-navy" onClick={enviar} disabled={estado === "enviando" || !grabacion}
        style={{ fontSize: 12, padding: "5px 13px", whiteSpace: "nowrap" }}>
        {estado === "enviando" ? "Enviando…" : "Enviar audio"}
      </button>
      {error && (
        <div style={{ fontSize: 11.5, color: "#b91c1c", flexBasis: "100%" }}>{error}</div>
      )}
    </div>
  );
}
