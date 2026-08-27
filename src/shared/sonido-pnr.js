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
// Se guarda en el navegador y no en la base: es una preferencia de quien está
// sentado ahí, no del analista como persona. La misma cuenta en la torre de
// México y en un portátil en casa puede querer volúmenes distintos.
// ═══════════════════════════════════════════════════════════════════════════

const LLAVE = "pnr_sonido";
const NIVELES = ["silencio", "suave", "normal", "fuerte"];
const GANANCIA = { suave: 0.12, normal: 0.3, fuerte: 0.6 };

function leer() {
  try {
    const g = JSON.parse(window.localStorage.getItem(LLAVE) || "{}");
    return {
      activo: g.activo !== false,
      nivel: NIVELES.includes(g.nivel) && g.nivel !== "silencio" ? g.nivel : "normal",
    };
  } catch {
    return { activo: true, nivel: "normal" };
  }
}

// Dos notas descendentes, 660 → 440 Hz. La torre usa tonos ascendentes y más
// agudos, así que se distinguen sin mirar la pantalla — que es el punto de
// tenerlos separados.
export function sonarPnr(nivel) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const vol = GANANCIA[nivel] || GANANCIA.normal;

    [[660, 0], [440, 0.18]].forEach(([hz, t]) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      g.gain.setValueAtTime(0, ctx.currentTime + t);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.16);
      osc.connect(g).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.18);
    });

    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch {
    // Sin audio disponible el aviso visual igual aparece.
  }
}

// Un evento propio para que las dos partes que leen esto —la campana del Topbar
// y el contenedor de avisos— se enteren del cambio. localStorage no avisa a la
// misma pestaña que lo escribió.
const EVENTO = "pnr-sonido-cambio";

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

  const guardar = useCallback((nuevo) => {
    try { window.localStorage.setItem(LLAVE, JSON.stringify(nuevo)); } catch { /* modo privado */ }
    setCfg(nuevo);
    window.dispatchEvent(new Event(EVENTO));
  }, []);

  // Suena al elegir, para poder calibrarlo: sin escucharlo no hay forma de
  // saber si "Suave" alcanza en esta sala.
  const setNivel = useCallback((nivel) => {
    if (nivel === "silencio") { guardar({ activo: false, nivel: cfg.nivel }); return; }
    guardar({ activo: true, nivel });
    sonarPnr(nivel);
  }, [cfg.nivel, guardar]);

  const probar = useCallback(() => {
    if (cfg.activo) sonarPnr(cfg.nivel);
  }, [cfg]);

  return { activo: cfg.activo, nivel: cfg.nivel, setNivel, probar };
}
