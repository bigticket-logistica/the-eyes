import { sb } from "./supabase";

const FRESCURA_MS = 5 * 60 * 1000; // 5 minutos

// Decide si el cache del caso sigue fresco (< 5 min).
export function cacheFresco(caso) {
  if (!caso?.detalle_actualizado_en) return false;
  const edad = Date.now() - new Date(caso.detalle_actualizado_en).getTime();
  return edad < FRESCURA_MS;
}

// Arma el objeto de detalle a partir de las columnas cacheadas del caso.
export function detalleDesdeCache(caso) {
  return {
    conductor: {
      nombre: caso.conductor_nombre, telefono: caso.conductor_telefono,
      mail: caso.conductor_mail, patente: caso.patente,
      vehiculo: caso.vehiculo, con_auxiliar: caso.con_auxiliar,
    },
    comprador: {
      nombre: caso.comprador_nombre, telefono: caso.comprador_telefono,
      telefonos: caso.comprador_telefonos, mail: caso.comprador_mail,
    },
    metricas: {
      entregados: caso.entregados, fallidas: caso.fallidas,
      pct_fallidas: caso.pct_fallidas, paquetes_en_ruta: caso.paquetes_en_ruta,
      horas_en_ruta: caso.horas_en_ruta, avance_ruta: caso.avance_ruta,
      id_orden: caso.id_orden, sin_actividad: caso.sin_actividad,
      estacion: caso.estacion_origen, ruta: caso.route_code,
    },
    desde_cache: true,
  };
}

// Llama a la Edge Function (proxy seguro al VPS) para traer detalle fresco.
// El VPS ademas lo guarda en cache. invoke() adjunta el token del analista.
export async function traerDetalleCaso(caseId) {
  const { data, error } = await sb.functions.invoke(`detalle-caso/${caseId}`, { method: "GET" });
  if (error) throw error;
  if (!data || data.ok === false) throw new Error(data?.error || "Error al traer detalle");
  return data;
}
