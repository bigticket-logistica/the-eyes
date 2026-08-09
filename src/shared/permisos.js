// ═══════════════════════════════════════════════════════════════════════════
// PERMISOS POR ROL
//
// El bloqueo REAL vive en la base: hay disparadores en crm_inc_casos,
// crm_inc_mensajes y crm_inc_asignaciones que rechazan cualquier escritura de un
// observador, venga de donde venga.
//
// Esto es solo la capa de interfaz: sirve para que un observador no vea botones
// que le van a dar error. No es una medida de seguridad y no debe tratarse como
// tal — si esto fallara, la base sigue protegiendo.
// ═══════════════════════════════════════════════════════════════════════════

export function puedeActuar(analista) {
  if (!analista) return false;
  return analista.rol === "admin" || analista.rol === "analista";
}

export function esObservador(analista) {
  return analista?.rol === "observador";
}

// Un observador conectado condiciona cómo trabaja la gente: se sabe mirado.
// Por eso no aparece en la presencia del resto — solo un admin lo ve.
export function veObservadores(analista) {
  return analista?.rol === "admin";
}
