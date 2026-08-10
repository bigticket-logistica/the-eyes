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

// ═══════════════════════════════════════════════════════════════════════════
// SONIDO DE AVISO
//
// EL BUG QUE HABÍA: la versión anterior creaba un AudioContext NUEVO en cada
// ding. Chrome permite unos seis por pestaña y después los rechaza, así que a
// partir del sexto mensaje el sonido dejaba de funcionar hasta recargar la
// página. Ahora hay UNO solo, reutilizado.
//
// POR QUÉ SE ESCUCHA MÁS SIN SUBIR EL VOLUMEN DEL SISTEMA
//   · El gain estaba en 0.15 — un 15% del máximo.
//   · 880 Hz cae donde el oído es poco sensible. El aviso ahora está en 2.6 kHz,
//     la zona de máxima sensibilidad auditiva: a igual volumen se percibe mucho
//     más fuerte.
//   · Dos pulsos separados 170 ms se detectan mejor que uno solo, incluso a
//     menor volumen: el cerebro reacciona al patrón, no solo a la intensidad.
//   · Onda triangular y no senoidal: la senoidal es la que menos se oye.
//
// El nivel "fuerte" pasa de 1.0 en el GainNode, que es la única forma de sonar
// por encima del máximo del sistema. Distorsiona un poco a propósito: en una
// torre de control con ruido es preferible.
// ═══════════════════════════════════════════════════════════════════════════

export const NIVELES_SONIDO = { silencio: 0, suave: 0.3, normal: 0.85, fuerte: 1.7 };

const CLAVE_NIVEL = "the-eyes-nivel-sonido";

export function nivelGuardado() {
  try {
    const v = localStorage.getItem(CLAVE_NIVEL);
    return v && v in NIVELES_SONIDO ? v : "normal";
  } catch { return "normal"; }
}

let ctxAudio = null;

// Un solo contexto para toda la sesión. Además se reanuda: el navegador lo deja
// "suspended" hasta que la persona interactúa con la página, así que el primer
// aviso de la mañana no sonaría si nadie hizo clic todavía.
function contextoAudio() {
  try {
    if (!ctxAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctxAudio = new AC();
    }
    if (ctxAudio.state === "suspended") ctxAudio.resume().catch(() => {});
    return ctxAudio;
  } catch { return null; }
}

function pulso(ctx, t0, freq, dur, vol, tipo) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = tipo;
  osc.frequency.setValueAtTime(freq, t0);
  osc.connect(g); g.connect(ctx.destination);
  // exponentialRamp no admite cero: de ahí los 0.0001 en los extremos.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

// vol: amplitud (ver NIVELES_SONIDO) · pulsos: cuántas veces suena
function reproducirDing(vol = 0.85, pulsos = 2) {
  if (!vol || vol <= 0) return;
  const ctx = contextoAudio();
  if (!ctx) return;
  const base = ctx.currentTime + 0.02;
  for (let i = 0; i < pulsos; i++) {
    const t0 = base + i * 0.17;
    pulso(ctx, t0, 2637, 0.13, vol * 0.55, "triangle");   // el que se oye
    pulso(ctx, t0, 1319, 0.13, vol * 0.45, "sine");       // octava abajo: cuerpo
  }
}

export function AlertasProvider({ children }) {
  const { analista } = useAuth();
  const [noLeidos, setNoLeidos] = useState(0);
  const [correosNoLeidos, setCorreosNoLeidos] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [sonidoActivo, setSonidoActivo] = useState(true);
  const sonidoRef = useRef(sonidoActivo);
  sonidoRef.current = sonidoActivo;

  // Nivel de volumen, elegido por cada persona y recordado en su navegador: en
  // una torre con ruido no sirve el mismo nivel que en una oficina callada.
  const [nivelSonido, setNivel] = useState(nivelGuardado);
  const nivelRef = useRef(nivelSonido);
  nivelRef.current = nivelSonido;

  const setNivelSonido = useCallback((n) => {
    if (!(n in NIVELES_SONIDO)) return;
    setNivel(n);
    try { localStorage.setItem("the-eyes-nivel-sonido", n); } catch { /* modo privado */ }
    // Se prueba al elegir: sin escucharlo no hay forma de calibrar.
    reproducirDing(NIVELES_SONIDO[n], 2);
  }, []);

  const probarSonido = useCallback(() => {
    reproducirDing(NIVELES_SONIDO[nivelRef.current] ?? 0.85, 2);
  }, []);

  // volumen efectivo: el interruptor manda sobre el nivel
  const vol = useCallback(
    () => (sonidoRef.current ? (NIVELES_SONIDO[nivelRef.current] ?? 0.85) : 0), []);

  // El navegador deja el audio "suspended" hasta el primer gesto de la persona.
  // Sin esto, el primer aviso de la jornada no suena y parece que el sistema
  // falla. Se desbloquea con el primer clic o la primera tecla, una sola vez.
  useEffect(() => {
    const abrir = () => { contextoAudio(); };
    window.addEventListener("pointerdown", abrir, { once: true });
    window.addEventListener("keydown", abrir, { once: true });
    return () => {
      window.removeEventListener("pointerdown", abrir);
      window.removeEventListener("keydown", abrir);
    };
  }, []);

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
          // Un correo es menos urgente que un conductor en ruta: un solo pulso.
          reproducirDing(vol(), 1);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
        })
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_inc_correos" },
        () => cargarCorreos())
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarCorreos, vol]);

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
          // Lo más importante que puede pasar: tres pulsos, el aviso más
          // insistente de los tres. Es alguien en la calle esperando.
          reproducirDing(vol(), 3);
          // auto-desvanecer a los 6s
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [vol]);

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
          // Informativo, no urgente: a mitad de volumen y un pulso.
          reproducirDing(vol() * 0.5, 1);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
        })
      .subscribe();
    return () => { vivo = false; sb.removeChannel(canal); };
  }, [analista?.id]);

  return (
    <AlertasCtx.Provider value={{ noLeidos, correosNoLeidos, toasts, sonidoActivo, setSonidoActivo,
      nivelSonido, setNivelSonido, probarSonido, marcarVistos, quitarToast }}>
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
