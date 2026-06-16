import { createContext, useContext, useEffect, useState } from "react";
import { sb } from "./supabase";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [sesion, setSesion] = useState(null);
  const [analista, setAnalista] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      setSesion(data.session);
      if (data.session) cargarAnalista(data.session.user.id);
      else setCargando(false);
    });

    const { data: sub } = sb.auth.onAuthStateChange((_e, ses) => {
      setSesion(ses);
      if (ses) cargarAnalista(ses.user.id);
      else { setAnalista(null); setCargando(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function cargarAnalista(userId) {
    setCargando(true);
    const { data } = await sb
      .from("crm_analistas")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    setAnalista(data);
    setCargando(false);
  }

  const entrar = (email, password) =>
    sb.auth.signInWithPassword({ email, password });

  const salir = () => sb.auth.signOut();

  return (
    <AuthCtx.Provider value={{ sesion, analista, cargando, entrar, salir }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
