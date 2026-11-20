import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. " +
    "Copia .env.example a .env y completa los valores."
  );
}

export const sb = createClient(url ?? "", anonKey ?? "", {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ── Chile ───────────────────────────────────────────────────────────────────
//   Los datos de Chile viven en su propio Supabase (bigticket-cl). La torre
//   habla con las dos bases: el login y todo lo de México siguen en `sb`; lo
//   de Chile se lee con `sbCL`.
//
//   Sin sesión propia a propósito. El analista ya inició sesión en México, y
//   un segundo cliente que también guardara sesión pelearía por el mismo lugar
//   en el navegador. Las tablas de Chile que lee la torre tienen política de
//   lectura abierta, así que la clave anónima alcanza.
const urlCL = import.meta.env.VITE_SUPABASE_CL_URL;
const keyCL = import.meta.env.VITE_SUPABASE_CL_KEY;

export const sbCL = urlCL && keyCL
  ? createClient(urlCL, keyCL, {
      auth: { persistSession: false, autoRefreshToken: false,
              storageKey: "sb-cl-sin-sesion" },
    })
  : null;   // sin las variables, la torre sigue funcionando solo con México
