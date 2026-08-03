import { useState, useEffect } from "react";
import { sb } from "../shared/supabase.js";
import { fechaHora } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// BURBUJA DE CHAT · compartida por HiloTicket (Ticketera) y Consultas.
// Antes había una copia en cada módulo; se unificaron para que los adjuntos
// se vean igual en los dos y para arreglar que las plantillas salían como
// "[plantilla]" en la Ticketera.
//
// ADJUNTOS: el bucket crm-media es PRIVADO, así que no sirve una URL fija.
// Se pide una URL firmada al abrir el hilo. La firma se cachea en memoria
// (55 min) para no re-firmar en cada refresco de 30 s ni en cada render.
//
// El binario lo baja a Storage el worker biggy-media.cjs del VPS de The Eyes.
// Si media_path está vacío, el adjunto aún no se procesó: se muestra el
// estado en lugar de un recuadro roto.
// ═══════════════════════════════════════════════════════════════════════════

const TEXTO_PLANO = ["texto", "plantilla"];
const ICONO = {
  imagen: "🖼", audio: "🎧", documento: "📄",
  video: "🎬", ubicacion: "📍", sticker: "😀",
};

const cacheUrl = new Map();   // media_path → { url, expira }

async function urlFirmada(path) {
  if (!path) return null;
  const guardada = cacheUrl.get(path);
  if (guardada && guardada.expira > Date.now()) return guardada.url;
  const { data, error } = await sb.storage.from("crm-media").createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) {
    console.warn("No se pudo firmar el adjunto:", path, error?.message);
    return null;
  }
  cacheUrl.set(path, { url: data.signedUrl, expira: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}

function pesoLegible(bytes) {
  if (!bytes) return "";
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Mapa de una ubicación compartida por el conductor ───────────────────────
function Mapa({ lat, lng }) {
  const d = 0.004;                                  // ~450 m de recuadro
  const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
  const gmaps = `https://www.google.com/maps?q=${lat},${lng}`;
  return (
    <div style={{ marginTop: 4 }}>
      <iframe
        title="Ubicación del conductor"
        src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`}
        style={{ width: 260, height: 170, border: "1px solid var(--borde)", borderRadius: 8, display: "block" }}
        loading="lazy"
      />
      <a href={gmaps} target="_blank" rel="noreferrer"
        style={{ fontSize: 11, color: "var(--naranja)", display: "inline-block", marginTop: 4 }}>
        Abrir en Google Maps ↗
      </a>
      <div style={{ fontSize: 10, opacity: 0.55, marginTop: 1 }}>
        {Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}
      </div>
    </div>
  );
}

// ── Adjunto genérico ────────────────────────────────────────────────────────
function Adjunto({ m }) {
  const [url, setUrl] = useState(null);
  const [ampliada, setAmpliada] = useState(false);

  useEffect(() => {
    let vivo = true;
    if (m.media_path) urlFirmada(m.media_path).then((u) => { if (vivo) setUrl(u); });
    return () => { vivo = false; };
  }, [m.media_path]);

  if (m.tipo_contenido === "ubicacion") {
    if (m.lat != null && m.lng != null) return <Mapa lat={m.lat} lng={m.lng} />;
    return <div style={{ fontSize: 12, opacity: 0.7 }}>📍 Ubicación sin coordenadas</div>;
  }

  // Todavía sin bajar de Meta: mejor decir en qué va que mostrar un roto.
  if (!m.media_path) {
    const espera = {
      pendiente: "en cola de descarga…",
      descargando: "descargando…",
      transcribiendo: "procesando…",
      error: "no se pudo descargar",
      expirado: "ya no disponible en WhatsApp",
    }[m.media_estado] || "sin archivo";
    return (
      <div style={{ fontSize: 12, opacity: 0.7, fontStyle: "italic" }}>
        {ICONO[m.tipo_contenido] || "📎"} {m.tipo_contenido} · {espera}
      </div>
    );
  }

  if (!url) {
    return <div style={{ fontSize: 12, opacity: 0.6 }}>{ICONO[m.tipo_contenido] || "📎"} cargando…</div>;
  }

  if (m.tipo_contenido === "imagen" || m.tipo_contenido === "sticker") {
    return (
      <>
        <img
          src={url} alt="Adjunto del conductor" onClick={() => setAmpliada(true)}
          style={{
            maxWidth: 260, maxHeight: 260, borderRadius: 8, display: "block",
            marginTop: 4, cursor: "zoom-in", border: "1px solid var(--borde)",
          }}
        />
        {ampliada && (
          <div
            onClick={() => setAmpliada(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,.82)", zIndex: 9999,
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out",
            }}>
            <img src={url} alt="Adjunto ampliado"
              style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 6 }} />
          </div>
        )}
      </>
    );
  }

  if (m.tipo_contenido === "audio") {
    return (
      <div style={{ marginTop: 4 }}>
        {/* WhatsApp entrega OGG/Opus: suena en Chrome, Edge, Firefox y Android.
            Safari e iPhone NO lo reproducen; por eso la transcripción de abajo
            es la que siempre se puede leer. */}
        <audio controls src={url} style={{ width: 250, height: 34 }} />
        <a href={url} download style={{ fontSize: 11, color: "var(--naranja)", display: "block", marginTop: 2 }}>
          Descargar audio ↓ {pesoLegible(m.media_bytes)}
        </a>
      </div>
    );
  }

  if (m.tipo_contenido === "video") {
    return <video controls src={url} style={{ maxWidth: 280, borderRadius: 8, marginTop: 4, display: "block" }} />;
  }

  // documento y cualquier otro tipo
  return (
    <a href={url} target="_blank" rel="noreferrer"
      style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4, padding: "8px 10px",
        border: "1px solid var(--borde)", borderRadius: 8, background: "#fff",
        textDecoration: "none", color: "var(--texto)", maxWidth: 250,
      }}>
      <span style={{ fontSize: 20 }}>📄</span>
      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {m.media_path.split("/").pop()}
        <span style={{ display: "block", fontSize: 10, opacity: 0.6 }}>
          {pesoLegible(m.media_bytes)} · abrir ↗
        </span>
      </span>
    </a>
  );
}

// ── Transcripción / descripción producida por IA ─────────────────────────────
function Transcripcion({ m }) {
  if (!m.transcripcion) return null;
  const alerta = m.transcripcion.startsWith("ALERTA:");
  const etiqueta = m.tipo_contenido === "audio" ? "🎧 Transcripción" : "👁 Descripción";
  return (
    <div style={{
      marginTop: 6, padding: "6px 8px", borderRadius: 7, fontSize: 12,
      background: alerta ? "#fef2f2" : "#f8fafc",
      border: `1px solid ${alerta ? "#fca5a5" : "var(--borde)"}`,
      color: alerta ? "#b91c1c" : "var(--texto-suave)",
      maxWidth: 280,
    }}>
      <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>
        {alerta ? "🚨 " : ""}{etiqueta}{m.transcriptor ? ` · ${m.transcriptor}` : ""}
      </div>
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.transcripcion}</div>
    </div>
  );
}

// ── Burbuja ─────────────────────────────────────────────────────────────────
export default function Burbuja({ m }) {
  const saliente = m.direccion === "saliente";
  const esIA = m.emisor === "ia";
  const esTexto = TEXTO_PLANO.includes(m.tipo_contenido);
  const bg = saliente ? (esIA ? "#EEF2FF" : "var(--navy)") : "#fff";
  const color = saliente && !esIA ? "#fff" : "var(--texto)";

  return (
    <div style={{ display: "flex", justifyContent: saliente ? "flex-end" : "flex-start" }}>
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

        {esTexto ? (
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.texto}</div>
        ) : (
          <>
            <Adjunto m={m} />
            {m.texto && (
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 5 }}>
                {m.texto}
              </div>
            )}
            <Transcripcion m={m} />
          </>
        )}

        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3, textAlign: "right" }}>
          {fechaHora(m.creado_en)}{saliente && m.estado_entrega ? ` · ${m.estado_entrega}` : ""}
        </div>
      </div>
    </div>
  );
}
