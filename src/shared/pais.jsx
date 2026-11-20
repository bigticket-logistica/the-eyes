import { createContext, useContext, useEffect, useState } from "react";
import { useAuth } from "./auth.jsx";
import { sbCL } from "./supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
//  PAÍS DE LA TORRE
//
//  La misma torre sirve a México y a Chile. El país elegido decide qué
//  pestañas se ven y de qué base se leen los datos.
//
//  Arranca en el país del analista (crm_analistas.pais) y después recuerda la
//  última elección en este navegador: quien trabaja Chile no tiene que cambiar
//  el selector cada vez que entra.
//
//  Si faltan las variables de Chile en el despliegue, Chile no se ofrece y la
//  torre queda en México. Así un despliegue a medias nunca deja a nadie
//  mirando una pantalla vacía.
// ═══════════════════════════════════════════════════════════════════════════

const CLAVE = "the-eyes-pais";
export const PAISES = sbCL ? ["MX", "CL"] : ["MX"];

const Ctx = createContext({ pais: "MX", setPais: () => {} });

// La pantalla de ingreso queda fuera de la sesión y no puede usar el contexto.
// Por eso el país también se lee y se guarda directo en el navegador: lo que se
// elige al entrar es lo primero que lee la torre al abrirse.
export function paisGuardado() {
  try {
    const g = localStorage.getItem(CLAVE);
    return PAISES.includes(g) ? g : null;
  } catch { return null; }
}
export function guardarPais(p) {
  if (!PAISES.includes(p)) return;
  try { localStorage.setItem(CLAVE, p); } catch { /* sin almacenamiento */ }
}

export function PaisProvider({ children }) {
  const { analista } = useAuth();
  const [pais, setPaisState] = useState(() => {
    try {
      const guardado = localStorage.getItem(CLAVE);
      if (PAISES.includes(guardado)) return guardado;
    } catch { /* navegador sin almacenamiento: se usa el del analista */ }
    return "MX";
  });

  // Primera vez en este navegador: el del perfil del analista.
  useEffect(() => {
    let guardado = null;
    try { guardado = localStorage.getItem(CLAVE); } catch { /* sin almacenamiento */ }
    if (!guardado && PAISES.includes(analista?.pais)) setPaisState(analista.pais);
  }, [analista?.pais]);

  const setPais = (p) => {
    if (!PAISES.includes(p)) return;
    setPaisState(p);
    try { localStorage.setItem(CLAVE, p); } catch { /* sin almacenamiento */ }
  };

  return <Ctx.Provider value={{ pais, setPais }}>{children}</Ctx.Provider>;
}

export const usePais = () => useContext(Ctx);
