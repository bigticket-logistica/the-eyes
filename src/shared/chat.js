import { sb } from "./supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// CHAT INTERNO · utilidades compartidas
//
// Los case_id de consulta viven en el rango 900.000.000+ (elegido así para no
// colisionar con los IDs de caso de MELI). Ese umbral es el que decide a qué
// pestaña lleva un enlace: Consultas o Incidencias.
// ═══════════════════════════════════════════════════════════════════════════

export const UMBRAL_CONSULTA = 900000000;

export const esConsulta = (caseId) => Number(caseId) >= UMBRAL_CONSULTA;

// Ruta interna a la que apunta un ticket mencionado en el chat.
export const rutaDeTicket = (caseId) =>
  esConsulta(caseId) ? `/consultas?caso=${caseId}` : `/?caso=${caseId}`;

// Primer "#123456" del texto. 6 dígitos mínimo para no capturar "#3" ni una
// hora como "#15". Devuelve número o null.
export function detectarCaseId(texto) {
  const m = String(texto || "").match(/#(\d{6,})/);
  return m ? Number(m[1]) : null;
}

// Parte un texto en trozos, marcando las menciones de ticket para poder
// renderizarlas como enlace sin usar dangerouslySetInnerHTML.
export function trozosConTickets(texto) {
  const out = [];
  const re = /#(\d{6,})/g;
  let ultimo = 0, m;
  while ((m = re.exec(texto)) !== null) {
    if (m.index > ultimo) out.push({ tipo: "texto", valor: texto.slice(ultimo, m.index) });
    out.push({ tipo: "ticket", valor: m[0], caseId: Number(m[1]) });
    ultimo = m.index + m[0].length;
  }
  if (ultimo < texto.length) out.push({ tipo: "texto", valor: texto.slice(ultimo) });
  return out;
}

// ── Publicar un ticket en el chat de la torre ───────────────────────────────
// La fecha la pone el trigger de la base en hora de México; acá no se manda.
export async function compartirTicketEnChat({ analistaId, caso, nota }) {
  if (!analistaId) throw new Error("Sin analista identificado");
  if (!caso?.case_id) throw new Error("El ticket no tiene case_id");

  const etiqueta = caso.codigo || `#${caso.case_id}`;
  const partes = [
    `📌 ${etiqueta}`,
    caso.motivo_label || caso.motivo_id,
    caso.route_code ? `Ruta ${caso.route_code}` : null,
    caso.conductor_nombre,
    caso.estacion_origen,
  ].filter(Boolean);

  const texto = partes.join(" · ") + (nota ? `\n${nota}` : "");

  const { error } = await sb.from("crm_chat_analistas").insert({
    analista_id: analistaId,
    texto,
    case_id: caso.case_id,
  });
  if (error) throw new Error(error.message);
}
