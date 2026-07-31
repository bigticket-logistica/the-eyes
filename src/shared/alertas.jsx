import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { sb } from "./supabase.js";
import { useAuth } from "./auth.jsx";

// Contexto global de alertas de mensajes entrantes.
// Escucha Realtime sobre crm_inc_mensajes y expone:
//  - noLeidos: total de entrantes sin atender (para el badge)
//  - toasts: avisos efímeros en pantalla
//  - sonidoActivo / setSonidoActivo: control del "ding"
//  - marcarVistos(): resetea el contador (al entrar a Consultas)
const AlertasCtx = createContext(null);

// "ding" sutil generado con Web Audio (sin archivo externo)
function reproducirDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;            // nota aguda corta
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.start(); osc.stop(ctx.currentTime + 0.26);
  } catch { /* navegador sin audio: ignorar */ }
}

export function AlertasProvider({ children }) {
  const { analista } = useAuth();
  const [noLeidos, setNoLeidos] = useState(0);
  const [correosNoLeidos, setCorreosNoLeidos] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [sonidoActivo, setSonidoActivo] = useState(true);
  const sonidoRef = useRef(sonidoActivo);
  sonidoRef.current = sonidoActivo;

  const quitarToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const marcarVistos = useCallback(() => setNoLeidos(0), []);

  // contador de correos entrantes sin leer (badge de la pestaña Correos)
  const cargarCorreos = useCallback(async () => {
    try {
      const { count } = await sb.from("crm_inc_correos")
        .select("id", { count: "exact", head: true })
        .eq("direccion", "entrante").eq("leido", false);
      setCorreosNoLeidos(count || 0);
    } catch { /* ignorar */ }
  }, []);
  useEffect(() => { cargarCorreos(); }, [cargarCorreos]);

  // Realtime: correo entrante nuevo → badge + toast + sonido
  useEffect(() => {
    const canal = sb.channel("alertas-correos")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_inc_correos", filter: "direccion=eq.entrante" },
        (payload) => {
          const c = payload.new || {};
          cargarCorreos();
          const id = "co-" + c.id + "-" + Date.now();
          const quien = c.nombre_de || c.remitente || "un cliente";
          setToasts((prev) => [...prev, {
            id, titulo: "✉️ Correo nuevo",
            texto: `${quien}: ${String(c.asunto || "(sin asunto)").slice(0, 70)}`,
          }].slice(-4));
          if (sonidoRef.current) reproducirDing();
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
        })
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_inc_correos" },
        () => cargarCorreos())
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarCorreos]);

  // contador inicial de entrantes sin caso (consultas pendientes)
  const cargarContador = useCallback(async () => {
    try {
      const { count } = await sb.from("crm_inc_conversaciones")
        .select("id", { count: "exact", head: true })
        .gt("no_leidos", 0);
      setNoLeidos(count || 0);
    } catch { /* ignorar */ }
  }, []);

  useEffect(() => { cargarContador(); }, [cargarContador]);

  // Realtime: cada mensaje entrante nuevo dispara badge + toast + sonido
  useEffect(() => {
    const canal = sb.channel("alertas-mensajes")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_inc_mensajes", filter: "direccion=eq.entrante" },
        (payload) => {
          const m = payload.new;
          setNoLeidos((n) => n + 1);
          const id = m.id || Math.random().toString(36);
          const texto = m.texto ? (m.texto.length > 60 ? m.texto.slice(0, 60) + "…" : m.texto) : "[adjunto]";
          setToasts((prev) => [...prev, { id, titulo: "Nuevo mensaje de conductor", texto }].slice(-4));  // máx 4 a la vez
          if (sonidoRef.current) reproducirDing();
          // auto-desvanecer a los 6s
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, []);

  // Realtime: aviso en vivo cuando OTRO analista (o Biggy) toma o recibe un
  // ticket. Fuente: crm_inc_asignaciones — cada toma/traspaso es un INSERT,
  // así el toast salta en el momento exacto, sin inferir transiciones.
  const nombresRef = useRef({});
  useEffect(() => {
    let vivo = true;
    sb.from("crm_analistas").select("id, nombre").then(({ data }) => {
      if (vivo) nombresRef.current = Object.fromEntries((data || []).map((a) => [a.id, a.nombre]));
    });

    const canal = sb.channel("alertas-asignaciones")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_inc_asignaciones" },
        (payload) => {
          const a = payload.new;
          if (analista?.id && a.analista_id === analista.id) return;  // mis tomas no me avisan
          const nombre = nombresRef.current[a.analista_id] || "Un analista";
          const cod = Number(a.case_id) >= 900000000
            ? "BT-" + String(Number(a.case_id) - 900000000).padStart(8, "0")
            : "#" + a.case_id;
          const id = "as-" + a.id + "-" + Date.now();
          setToasts((prev) => [...prev, {
            id, titulo: "🎫 Ticket tomado",
            texto: `${nombre} tomó el ticket ${cod}`,
          }].slice(-4));
          if (sonidoRef.current) reproducirDing();
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
        })
      .subscribe();
    return () => { vivo = false; sb.removeChannel(canal); };
  }, [analista?.id]);

  return (
    <AlertasCtx.Provider value={{ noLeidos, correosNoLeidos, toasts, sonidoActivo, setSonidoActivo, marcarVistos, quitarToast }}>
      {children}
    </AlertasCtx.Provider>
  );
}

export function useAlertas() {
  const ctx = useContext(AlertasCtx);
  if (!ctx) throw new Error("useAlertas fuera de AlertasProvider");
  return ctx;
}

// Componente visual de los toasts (esquina inferior derecha)
export function ContenedorToasts() {
  const { toasts, quitarToast } = useAlertas();
  if (!toasts.length) return null;
  return (
    <div style={{ position: "fixed", right: 18, bottom: 18, display: "flex", flexDirection: "column",
      gap: 8, zIndex: 9999, maxWidth: 320 }}>
      {toasts.map((t) => (
        <div key={t.id} onClick={() => quitarToast(t.id)}
          style={{ background: "var(--navy)", color: "#fff", borderRadius: 10, padding: "10px 14px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)", cursor: "pointer", fontSize: 13,
            display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 12 }}>{t.titulo || "Nuevo mensaje de conductor"}</span>
          <span style={{ opacity: 0.85 }}>{t.texto}</span>
        </div>
      ))}
    </div>
  );
}
