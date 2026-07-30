import { sb } from "./supabase.js";

// Trae los mensajes de un caso (el hilo), en orden cronológico.
// Lee de crm_inc_mensajes ligados al case_id.
export async function mensajesDelCaso(caseId) {
  const { data, error } = await sb
    .from("crm_inc_mensajes")
    .select("id, direccion, emisor, emisor_id, tipo_contenido, texto, media_url, estado_entrega, creado_en")
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
  return data && data[0] ? data[0] : null;
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
  const { data, error } = await sb.functions.invoke("whatsapp-enviar", {
    body: { telefono, texto, case_id: caseId, emisor: "analista", emisor_id: emisorId, plantilla: plantilla || null },
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
    .select("id, case_id, direccion, emisor, tipo_contenido, texto, media_url, estado_entrega, creado_en")
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
