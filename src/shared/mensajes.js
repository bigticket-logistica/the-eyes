import { sb } from "./supabase.js";

// Trae los mensajes de un caso (el hilo), en orden cronológico.
// Lee de crm_inc_mensajes ligados al case_id.
export async function mensajesDelCaso(caseId) {
  const { data, error } = await sb
    .from("crm_inc_mensajes")
    .select("id, direccion, emisor, emisor_id, tipo_contenido, texto, media_url, estado_entrega, creado_en, "
            + "media_path, media_mime, media_bytes, media_estado, transcripcion, transcriptor, lat, lng")
    .eq("case_id", caseId)
    .order("creado_en", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Trae la conversación de un conductor por su teléfono (para la ventana 24h).
export async function conversacionPorTelefono(telefono) {
  if (!telefono) return null;
  const t = String(telefono).replace(/\D/g, "");
  const { data, error } = await sb
    .from("crm_inc_conversaciones")
    .select("id, telefono, ultimo_entrante_en, ultimo_mensaje_en")
    .like("telefono", `%${t.slice(-10)}`)
    .limit(1);
  if (error) throw error;
  const conv = data && data[0] ? data[0] : null;
  if (!conv) return null;
  // La ventana de 24h de Meta se mide con el último mensaje ENTRANTE. El campo
  // denormalizado de la conversación no siempre viene poblado, así que lo
  // verificamos contra los mensajes reales, que son la fuente de verdad.
  if (!conv.ultimo_entrante_en) {
    const { data: ent } = await sb
      .from("crm_inc_mensajes")
      .select("creado_en")
      .eq("conversacion_id", conv.id)
      .eq("direccion", "entrante")
      .order("creado_en", { ascending: false })
      .limit(1);
    if (ent && ent[0]) conv.ultimo_entrante_en = ent[0].creado_en;
  }
  return conv;
}

// ¿La ventana de 24h de Meta está abierta? (hay texto libre si el conductor
// escribió hace menos de 24h). Si no, hay que usar plantilla.
export function ventanaAbierta(conversacion) {
  if (!conversacion?.ultimo_entrante_en) return false;
  const ms = Date.now() - new Date(conversacion.ultimo_entrante_en).getTime();
  return ms < 24 * 60 * 60 * 1000;
}

// Envía un mensaje al conductor vía la Edge Function (proxy seguro al VPS).
// La Edge Function valida al analista y reenvía al endpoint /whatsapp-enviar.
// Si la ventana de 24h está cerrada, pasar `plantilla`:
//   { nombre: "contacto_ruta_torre", idioma: "es_MX", variables: [nombre, ruta, motivo] }
// (texto sigue siendo obligatorio: es lo que se guarda en el hilo).
// Devuelve { ok, wa_message_id, conversacion_id }.
export async function enviarMensaje({ telefono, texto, caseId, emisorId, plantilla }) {
  // Meta rechaza parámetros de plantilla con saltos de línea, tabulaciones o
  // 4+ espacios seguidos. Se aplanan antes de enviar (el texto que se guarda
  // en el hilo conserva su formato original).
  const aplanar = (v) => String(v ?? "").replace(/[\r\n\t]+/g, " · ").replace(/\s{2,}/g, " ").trim();
  const plt = plantilla
    ? { ...plantilla, variables: (plantilla.variables || []).map(aplanar) }
    : null;
  const { data, error } = await sb.functions.invoke("whatsapp-enviar", {
    body: { telefono, texto, case_id: caseId, emisor: "analista", emisor_id: emisorId, plantilla: plt },
  });
  if (error) throw error;
  if (!data || data.ok === false) throw new Error(data?.error || "No se pudo enviar");
  return data;
}

// Lista las conversaciones (chats con conductores), más reciente primero.
// Para la pestaña "Consultas en ruta".
export async function listarConversaciones() {
  const { data, error } = await sb
    .from("crm_inc_conversaciones")
    .select("id, telefono, conductor_nombre, ultimo_mensaje_texto, ultimo_mensaje_en, ultimo_entrante_en, no_leidos")
    .order("ultimo_mensaje_en", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

// Trae los mensajes de una conversación (todo el hilo, tenga o no caso).
export async function mensajesDeConversacion(conversacionId) {
  const { data, error } = await sb
    .from("crm_inc_mensajes")
    .select("id, case_id, direccion, emisor, tipo_contenido, texto, media_url, estado_entrega, creado_en, "
            + "media_path, media_mime, media_bytes, media_estado, transcripcion, transcriptor, lat, lng")
    .eq("conversacion_id", conversacionId)
    .order("creado_en", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Crea (o reusa) un caso de consulta desde una conversación. Devuelve el case_id.
// Llama al RPC fn_crear_caso_consulta.
export async function crearCasoConsulta(conversacionId, analistaId) {
  const { data, error } = await sb.rpc("fn_crear_caso_consulta", {
    p_conversacion_id: conversacionId,
    p_analista_id: analistaId,
  });
  if (error) throw error;
  return data; // case_id numérico
}

// Genera un resumen operativo de la conversacion con IA (Edge Function ia-resumen).
// transcript: texto plano "Conductor: ... / Analista: ..." linea por linea.
export async function resumenIA(transcript) {
  const { data, error } = await sb.functions.invoke("ia-resumen", { body: { transcript } });
  if (error) throw error;
  if (!data || data.ok === false) throw new Error(data?.error || "No se pudo generar el resumen");
  return data.resumen;
}

// Consulta puntual de un paquete MELI (Edge Function paquete-info → VPS).
// Devuelve { ok, paquete: { comprador, status, recibio, ... }, crudo }.
// Reintenta UNA vez tras 2s si falla la infraestructura (arranque en frío de
// la Edge Function o del navegador del VPS). Un 404 (paquete inexistente) es
// respuesta real y no se reintenta.
async function invocarPaquete(id) {
  const { data, error } = await sb.functions.invoke("paquete-info", { body: { id } });
  if (error) {
    // error de transporte/función (cold start, timeout, red) → reintentable
    const e = new Error("infra"); e.reintentable = true; throw e;
  }
  if (!data || data.ok === false) {
    const msg = data?.error || "";
    if (/no encontrado/i.test(msg)) throw new Error(`No existe un envío con el ID ${id}. Revisa el número.`);
    if (/sesi[oó]n/i.test(msg)) throw new Error("La sesión de MELI está vencida. Pide sincronizar Don B y reintenta.");
    const e = new Error(msg || "infra"); e.reintentable = !msg; throw e;
  }
  return data.paquete;
}

export async function consultarPaquete(id) {
  try {
    return await invocarPaquete(id);
  } catch (e1) {
    if (!e1.reintentable && e1.message !== "infra") throw e1;
    await new Promise((r) => setTimeout(r, 2000));   // segundo intento (frío → caliente)
    try {
      return await invocarPaquete(id);
    } catch (e2) {
      if (!e2.reintentable && e2.message !== "infra") throw e2;
      throw new Error("El buscador tardó en despertar y no alcanzó a responder. Espera unos segundos y vuelve a intentar.");
    }
  }
}

// Envía un correo al comprador desde la torre (Edge Function correo-cliente →
// VPS → Brevo). Queda registrado en crm_inc_correos, ligado al caso.
export async function enviarCorreoCliente({ caseId, casoId, destinatario, asunto, cuerpo, plantilla }) {
  const { data, error } = await sb.functions.invoke("correo-cliente", {
    body: { case_id: caseId, caso_id: casoId, destinatario, asunto, cuerpo, plantilla },
  });
  if (error) throw new Error("No se pudo enviar el correo. Reintenta en unos segundos.");
  if (!data || data.ok === false) throw new Error(data?.error || "No se pudo enviar el correo");
  return data;
}

// ── Adjuntos que todavía no maduraron ──────────────────────────────────────
// El worker biggy-media completa un adjunto en dos pasos posteriores al INSERT:
// primero media_path (descarga a Storage, ~15 s) y luego transcripcion (Whisper
// o Vision). Mientras alguno falte, el hilo debe seguir refrescando.
const TIPOS_ADJUNTO = ["imagen", "audio", "documento", "video", "sticker"];

export function adjuntoPendiente(m) {
  if (!TIPOS_ADJUNTO.includes(m?.tipo_contenido)) return false;
  if (!m.media_path) return true;
  if (["imagen", "audio"].includes(m.tipo_contenido) && !m.transcripcion) return true;
  return false;
}

// true si hay algo pendiente y RECIENTE. El límite de 3 minutos hace que el
// refresco se apague solo: si el worker está caído, no dejamos al navegador
// consultando para siempre.
export function hayAdjuntoMadurando(mensajes) {
  const limite = Date.now() - 3 * 60 * 1000;
  return (mensajes || []).some(
    (m) => adjuntoPendiente(m) && new Date(m.creado_en).getTime() > limite,
  );
}

// ── Enviar un adjunto al conductor ──────────────────────────────────────────
// El archivo se sube al bucket privado crm-media y la Edge Function firma una
// URL temporal para que Meta lo descargue. Solo funciona dentro de la ventana
// de 24 h: fuera de ella Meta exige plantilla y no admite media libre.
const LIMITES = {
  image:    { max: 5 * 1024 * 1024,   mimes: ["image/jpeg", "image/png"] },
  audio:    { max: 16 * 1024 * 1024,  mimes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"] },
  video:    { max: 16 * 1024 * 1024,  mimes: ["video/mp4", "video/3gpp"] },
  document: { max: 100 * 1024 * 1024, mimes: [] },
};

export function tipoDeArchivo(file) {
  const m = (file.type || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}

// Valida ANTES de subir: no tiene sentido gastar la subida para que Meta lo
// rechace después. Devuelve null si está bien, o el motivo si no.
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

export async function enviarAdjunto({ file, telefono, caseId, conversacionId, caption }) {
  const problema = validarAdjunto(file);
  if (problema) throw new Error(problema);

  const tipo = tipoDeArchivo(file);
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 5);
  const f = new Date();
  const ruta = `wa-out/${f.getFullYear()}/${String(f.getMonth() + 1).padStart(2, "0")}/` +
               `${crypto.randomUUID()}.${ext}`;

  const { error: errUp } = await sb.storage.from("crm-media")
    .upload(ruta, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (errUp) throw new Error(`No se pudo subir el archivo: ${errUp.message}`);

  const { data, error } = await sb.functions.invoke("whatsapp-media", {
    body: {
      telefono, media_path: ruta, tipo,
      caption: caption || null,
      case_id: caseId || null,
      conversacion_id: conversacionId || null,
    },
  });
  if (error) throw error;
  if (!data || data.ok === false) throw new Error(data?.error || "No se pudo enviar el adjunto");
  return data;
}

// ── Consulta de una ruta (Edge Function ruta-info → VPS) ────────────────────
// Devuelve { ok, ruta, totales, fallidos, sacas, multiparadas, problemas,
//            siguiente, comerciales_proximas, crudo }.
//
// Pedido por Monserrath el 13-ago: "aún hay Driver que no notifican y vamos a
// Logistic para visualizar cuáles son [sus fallidos]". El endpoint del VPS saca
// el motivo del fallido de dentro de cada parada — en el nivel superior MELI
// dice on_route para todo, incluso en rutas ya completadas.
//
// Mismo patrón de reintento que consultarPaquete: el navegador caliente del VPS
// puede estar arrancando en frío y un segundo intento tras 2 s lo resuelve. Un
// 404 (ruta inexistente) es respuesta real y no se reintenta.
async function invocarRuta(id) {
  const { data, error } = await sb.functions.invoke("ruta-info", { body: { id } });
  if (error) {
    const e = new Error("infra"); e.reintentable = true; throw e;
  }
  if (!data || data.ok === false) {
    const msg = data?.error || data?.motivo || "";
    if (/no encontrada/i.test(msg)) throw new Error(`No existe la ruta ${id}. Revisa el número.`);
    if (/sesi[oó]n/i.test(msg)) throw new Error("La sesión de MELI está vencida. Pide sincronizar Don B y reintenta.");
    const e = new Error(msg || "infra"); e.reintentable = !msg; throw e;
  }
  return data;
}

export async function consultarRuta(id) {
  try {
    return await invocarRuta(id);
  } catch (e1) {
    if (!e1.reintentable && e1.message !== "infra") throw e1;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await invocarRuta(id);
    } catch (e2) {
      if (!e2.reintentable && e2.message !== "infra") throw e2;
      throw new Error("El buscador de rutas tardó en despertar y no alcanzó a responder. Espera unos segundos y vuelve a intentar.");
    }
  }
}
