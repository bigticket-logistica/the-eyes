// Tiempo transcurrido legible: "hace 22 min", "hace 3 h", "hace 2 d"
export function hace(fecha) {
  if (!fecha) return "—";
  const ms = Date.now() - new Date(fecha).getTime();
  if (ms < 0) return "ahora";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

// Fecha y hora corta MX
export function fechaHora(fecha) {
  if (!fecha) return "—";
  return new Date(fecha).toLocaleString("es-MX", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// Minutos entre dos timestamps (para metricas)
export function minutosEntre(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

// Fecha "del dia" en zona MX (CDMX, UTC-6) en formato YYYY-MM-DD
function fechaMX(date) {
  const mx = new Date(date.getTime() - 6 * 3600 * 1000);
  return mx.toISOString().slice(0, 10);
}

// ¿El caso es de hoy (zona MX)? Compara fecha_caso contra el dia actual MX.
export function esDeHoyMX(fecha) {
  if (!fecha) return false;
  return fechaMX(new Date(fecha)) === fechaMX(new Date());
}
