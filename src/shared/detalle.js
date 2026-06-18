import { sb } from "./supabase";

// Llama a la Edge Function 'detalle-caso', que valida la sesion del analista
// y hace de proxy seguro al VPS. Devuelve { conductor, comprador, metricas }.
// invoke() adjunta automaticamente el token de sesion en el Authorization.
export async function traerDetalleCaso(caseId) {
  const { data, error } = await sb.functions.invoke(`detalle-caso/${caseId}`, {
    method: "GET",
  });
  if (error) throw error;
  if (!data || data.ok === false) throw new Error(data?.error || "Error al traer detalle");
  return data; // { ok, caseId, conductor, comprador, metricas, _raw }
}
