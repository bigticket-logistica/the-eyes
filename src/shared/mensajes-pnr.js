import { sb } from "./supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// CANAL DE POSVENTA · acceso desde el front
//
// Copia deliberada de shared/mensajes.js en vez de parametrizarlo. Ese archivo
// atiende el canal que usan los conductores en ruta: agregarle un parámetro de
// canal habría significado tocar código en producción para estrenar otro.
//
// LA DIFERENCIA DE FONDO CON CONSULTAS
//   Consultas manda llamando a las Edge Functions whatsapp-enviar y
//   whatsapp-media. Acá la salida es una COLA en la base: se inserta la fila
//   con estado_entrega = 'encolado' y el worker pnr-enviar.cjs del VPS la manda.
//
//   Con eso el token de WhatsApp nunca sale del servidor, el permiso lo
//   resuelve la política de RLS que ya existe, y si el worker se cae los
//   mensajes quedan esperando en vez de perderse. El costo es un retardo de dos
//   segundos, que en un canal donde el conductor responde en horas no se nota.
// ═══════════════════════════════════════════════════════════════════════════

export const BUCKET_PNR = "pnr-pruebas";

// ── Bandeja e hilo ─────────────────────────────────────────────────────────

export async function listarConversaciones() {
  const { data, error } = await sb.from("vw_pnr_bandeja")
    .select("*").order("ultimo_en", { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}

export async function mensajesDeConversacion(conversacionId) {
  const { data, error } = await sb.from("pnr_mensajes_mx")
    .select("*").eq("conversacion_id", conversacionId)
    .order("creado_en", { ascending: true }).limit(500);
  if (error) throw error;
  return data || [];
}

export async function marcarLeidos(conversacionId) {
  const { error } = await sb.from("pnr_conversaciones_mx")
    .update({ no_leidos: 0 }).eq("id", conversacionId);
  if (error) throw error;
}

// ── Ventana de 24 horas ────────────────────────────────────────────────────
// Meta solo permite texto libre si el conductor escribió en las últimas 24 h.
// Se calcula en el front para deshabilitar el campo antes de que el analista
// escriba, en vez de dejarlo redactar algo que va a rebotar.

export function ventanaAbierta(ultimoEntranteEn) {
  if (!ultimoEntranteEn) return false;
  return Date.now() - new Date(ultimoEntranteEn).getTime() < 24 * 3600 * 1000;
}

export function horasDeVentana(ultimoEntranteEn) {
  if (!ultimoEntranteEn) return 0;
  const quedan = 24 - (Date.now() - new Date(ultimoEntranteEn).getTime()) / 3600000;
  return Math.max(0, quedan);
}

// ── Cola de salida ─────────────────────────────────────────────────────────

async function encolar(fila) {
  const { data, error } = await sb.from("pnr_mensajes_mx").insert({
    ...fila,
    direccion: "saliente",
    estado_entrega: "encolado",
  }).select().single();
  if (error) throw new Error(`No se pudo encolar: ${error.message}`);
  return data;
}

export async function encolarTexto({ conversacionId, telefono, caseId, texto, emisor }) {
  const limpio = String(texto || "").trim();
  if (!limpio) throw new Error("El mensaje está vacío");
  return encolar({
    conversacion_id: conversacionId,
    telefono,
    case_id: caseId || null,
    tipo_contenido: "texto",
    texto: limpio,
    emisor: emisor || "analista",
  });
}

// ── Adjuntos ───────────────────────────────────────────────────────────────
// Los límites son los de Meta. Se valida ANTES de subir: no tiene sentido
// gastar la subida para que el worker reciba un 400 después.

const LIMITES = {
  image:    { max: 5 * 1024 * 1024,   mimes: ["image/jpeg", "image/png"] },
  audio:    { max: 16 * 1024 * 1024,  mimes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"] },
  video:    { max: 16 * 1024 * 1024,  mimes: ["video/mp4", "video/3gpp"] },
  document: { max: 100 * 1024 * 1024, mimes: [] },
};

const TIPO_TABLA = { image: "imagen", audio: "audio", video: "video", document: "documento" };

export function tipoDeArchivo(file) {
  const m = (file.type || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}

export function validarAdjunto(file) {
  const tipo = tipoDeArchivo(file);
  const lim = LIMITES[tipo];
  if (file.size > lim.max) {
    return `El archivo pesa ${(file.size / 1024 / 1024).toFixed(1)} MB y WhatsApp acepta hasta ${lim.max / 1024 / 1024} MB para ${tipo === "image" ? "imágenes" : tipo}.`;
  }
  if (lim.mimes.length && !lim.mimes.includes((file.type || "").toLowerCase())) {
    return `WhatsApp no acepta ${file.type || "ese formato"}. Permitidos: ${lim.mimes.join(", ")}.`;
  }
  return null;
}

export async function encolarAdjunto({ file, conversacionId, telefono, caseId, caption, emisor }) {
  const problema = validarAdjunto(file);
  if (problema) throw new Error(problema);

  const tipo = tipoDeArchivo(file);
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 5);
  const f = new Date();
  // Carpeta wa-out separada de la wa/ que usa el worker de entrada: así se
  // distingue de un vistazo qué mandó el conductor y qué mandamos nosotros.
  const ruta = `wa-out/${f.getFullYear()}/${String(f.getMonth() + 1).padStart(2, "0")}/` +
               `${crypto.randomUUID()}.${ext}`;

  const { error: errUp } = await sb.storage.from(BUCKET_PNR)
    .upload(ruta, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (errUp) throw new Error(`No se pudo subir el archivo: ${errUp.message}`);

  return encolar({
    conversacion_id: conversacionId,
    telefono,
    case_id: caseId || null,
    tipo_contenido: TIPO_TABLA[tipo] || "documento",
    texto: caption || null,
    media_path: ruta,
    media_mime: file.type || null,
    media_bytes: file.size,
    media_estado: "listo",
    emisor: emisor || "analista",
  });
}

// ── Audio grabado en el navegador ──────────────────────────────────────────
// Chrome graba en audio/webm y WhatsApp NO acepta WebM. La conversión a
// ogg-opus la hace el worker con ffmpeg: no se puede hacer en el navegador ni
// en una Edge Function, y Chrome es lo que usan las analistas por la extensión
// Don B, así que el caso principal es justo el incompatible.
//
// Acá se sube el archivo crudo y se marca para convertir; el worker se encarga.

export async function encolarAudio({ blob, mime, conversacionId, telefono, caseId, emisor }) {
  const ext = (mime || "").includes("ogg") ? "ogg" : (mime || "").includes("mp4") ? "m4a" : "webm";
  const f = new Date();
  const ruta = `wa-out/${f.getFullYear()}/${String(f.getMonth() + 1).padStart(2, "0")}/` +
               `${crypto.randomUUID()}.${ext}`;

  const { error: errUp } = await sb.storage.from(BUCKET_PNR)
    .upload(ruta, blob, { contentType: mime || "audio/webm", upsert: false });
  if (errUp) throw new Error(`No se pudo subir la grabación: ${errUp.message}`);

  return encolar({
    conversacion_id: conversacionId,
    telefono,
    case_id: caseId || null,
    tipo_contenido: "audio",
    media_path: ruta,
    media_mime: mime || "audio/webm",
    media_bytes: blob.size,
    // El worker ve "pendiente" y sabe que tiene que convertir antes de mandar.
    media_estado: ext === "webm" ? "pendiente" : "listo",
    emisor: emisor || "analista",
  });
}
