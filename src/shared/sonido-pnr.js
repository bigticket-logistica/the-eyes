import { useState, useEffect, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// SONIDO DEL CANAL DE POSVENTA
//
// Volumen propio, separado del de la torre. Los dos canales interrumpen por
// cosas distintas: la torre es un conductor detenido en ruta ahora, Posventa es
// un reclamo de una entrega de hace dos días. Un analista que está peleando
// tickets en vivo quiere la torre en "Fuerte" y Posventa en "Suave", y con una
// sola campana tenía que elegir.
//
// TRES COSAS COPIADAS DE shared/alertas.jsx, QUE YA LAS PAGÓ CARO
//
//   1. UN SOLO AudioContext para toda la sesión. La primera versión de este
//      archivo creaba uno nuevo en cada aviso: Chrome permite unos seis por
//      pestaña y después los rechaza, así que a partir del séptimo aviso el
//      sonido dejaba de funcionar hasta recargar la página.
//
//   2. FRECUENCIA ALTA. Los 660 y 440 Hz de la primera versión caen donde el
//      oído humano es poco sensible: a igual volumen se percibe mucho más bajo.
//      El aviso vive en la zona de 2 a 2.6 kHz, la de máxima sensibilidad.
//
//   3. ONDA TRIANGULAR y no senoidal. La senoidal es la que menos se oye.
//
// CÓMO SE DISTINGUE DE LA TORRE
//   La torre repite la misma nota dos o tres veces. Posventa hace dos notas
//   DESCENDENTES, 2637 → 1976 Hz, y más separadas: 250 ms contra 170. El patrón
//   se reconoce sin mirar la pantalla, que es el punto de tenerlos separados.
//
// El nivel "fuerte" pasa de 1.0 en el GainNode, que es la única forma de sonar
// por encima del máximo del sistema. Distorsiona un poco a propósito: en una
// torre con ruido es preferible.
// ═══════════════════════════════════════════════════════════════════════════

export const NIVELES_PNR = { silencio: 0, suave: 0.3, normal: 0.85, fuerte: 1.7 };

const LLAVE = "pnr_sonido";
const EVENTO = "pnr-sonido-cambio";

function leer() {
  try {
    const g = JSON.parse(window.localStorage.getItem(LLAVE) || "{}");
    const nivel = g.nivel in NIVELES_PNR && g.nivel !== "silencio" ? g.nivel : "normal";
    return { activo: g.activo !== false, nivel };
  } catch {
    return { activo: true, nivel: "normal" };
  }
}

let ctxAudio = null;

// Un solo contexto, y se reanuda: el navegador lo deja "suspended" hasta que la
// persona interactúa con la página, así que el primer aviso de la mañana no
// sonaría si nadie hizo clic todavía.
function contextoAudio() {
  try {
    if (!ctxAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctxAudio = new AC();
    }
    if (ctxAudio.state === "suspended") ctxAudio.resume().catch(() => {});
    return ctxAudio;
  } catch {
    return null;
  }
}

function pulso(ctx, t0, freq, dur, vol, tipo) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = tipo;
  osc.frequency.setValueAtTime(freq, t0);
  osc.connect(g);
  g.connect(ctx.destination);
  // exponentialRamp no admite cero: de ahí los 0.0001 en los extremos.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Dos notas descendentes. La torre repite la misma nota; esto baja, y con eso
// se distingue de oído sin mirar la pantalla.
export function sonarPnr(nivel) {
  const vol = typeof nivel === "number" ? nivel : (NIVELES_PNR[nivel] ?? NIVELES_PNR.normal);
  if (!vol || vol <= 0) return;
  const ctx = contextoAudio();
  if (!ctx) return;
  const base = ctx.currentTime + 0.02;

  // 2637 Hz y 1976 Hz: las dos en la zona sensible, una quinta de distancia.
  // La octava de abajo le da cuerpo sin bajar la frecuencia percibida.
  [[2637, 1319, 0], [1976, 988, 0.25]].forEach(([alto, bajo, t]) => {
    pulso(ctx, base + t, alto, 0.14, vol * 0.55, "triangle");
    pulso(ctx, base + t, bajo, 0.14, vol * 0.4, "sine");
  });
}

export function useSonidoPnr() {
  const [cfg, setCfg] = useState(leer);

  useEffect(() => {
    const alCambiar = () => setCfg(leer());
    window.addEventListener(EVENTO, alCambiar);
    window.addEventListener("storage", alCambiar);
    return () => {
      window.removeEventListener(EVENTO, alCambiar);
      window.removeEventListener("storage", alCambiar);
    };
  }, []);

  // Desbloquear el audio con el primer gesto. Sin esto el primer aviso de la
  // jornada no suena y parece que el sistema falla.
  useEffect(() => {
    const abrir = () => { contextoAudio(); };
    window.addEventListener("pointerdown", abrir, { once: true });
    window.addEventListener("keydown", abrir, { once: true });
    return () => {
      window.removeEventListener("pointerdown", abrir);
      window.removeEventListener("keydown", abrir);
    };
  }, []);

  const guardar = useCallback((nuevo) => {
    try { window.localStorage.setItem(LLAVE, JSON.stringify(nuevo)); } catch { /* modo privado */ }
    setCfg(nuevo);
    window.dispatchEvent(new Event(EVENTO));
  }, []);

  // Suena al elegir, para poder calibrarlo: sin escucharlo no hay forma de
  // saber si "Suave" alcanza en esta sala.
  const setNivel = useCallback((nivel) => {
    if (!(nivel in NIVELES_PNR)) return;
    if (nivel === "silencio") { guardar({ activo: false, nivel: cfg.nivel }); return; }
    guardar({ activo: true, nivel });
    sonarPnr(nivel);
  }, [cfg.nivel, guardar]);

  const probar = useCallback(() => {
    if (cfg.activo) sonarPnr(cfg.nivel);
  }, [cfg]);

  return { activo: cfg.activo, nivel: cfg.nivel, setNivel, probar };
}
