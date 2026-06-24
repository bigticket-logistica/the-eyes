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
export async function enviarMensaje({ telefono, texto, caseId, emisorId }) {
  const { data, error } = await sb.functions.invoke("whatsapp-enviar", {
    body: { telefono, texto, case_id: caseId, emisor: "analista", emisor_id: emisorId },
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
