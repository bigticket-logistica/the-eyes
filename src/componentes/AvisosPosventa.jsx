import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../shared/supabase.js";
import { useAlertas } from "../shared/alertas.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// AVISOS DEL CANAL DE POSVENTA
//
// Aparecen abajo a la IZQUIERDA, con un sonido distinto al de la torre. Los dos
// canales atienden cosas que no se parecen: la torre es un conductor en ruta
// con un problema ahora, Posventa es un reclamo de una entrega de hace dos
// días. Que suenen igual obliga a mirar la pantalla para saber cuál es urgente.
//
// El sonido se genera con WebAudio en vez de un archivo: dos notas descendentes,
// más graves y más lentas que el aviso de la torre. Sin archivo no hay que
// desplegar nada extra ni esperar que cargue.
//
// Respeta la campana del Topbar: si el analista silenció la torre, esto también
// se calla. Un solo control para las dos cosas.
// ═══════════════════════════════════════════════════════════════════════════

const VIDA_MS = 12000;   // más que el de la torre: acá no hay que reaccionar ya

const GANANCIA = { suave: 0.12, normal: 0.3, fuerte: 0.6 };

function sonar(nivel) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const vol = GANANCIA[nivel] || GANANCIA.normal;

    // Dos notas descendentes, 660 → 440 Hz. La torre usa tonos ascendentes y
    // más agudos, así que se distinguen sin mirar.
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

export default function AvisosPosventa() {
  const [avisos, setAvisos] = useState([]);
  const navegar = useNavigate();
  const alertas = useAlertas();
  // Se leen por referencia para que el canal de Realtime no se rearme cada vez
  // que el analista cambia el volumen.
  const cfg = useRef({ activo: true, nivel: "normal" });
  cfg.current = {
    activo: alertas ? alertas.sonidoActivo !== false : true,
    nivel: alertas ? alertas.nivelSonido || "normal" : "normal",
  };

  useEffect(() => {
    const canal = sb.channel("pnr-avisos-globales")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "pnr_mensajes_mx" },
        async (payload) => {
          const m = payload.new;
          if (!m || m.direccion !== "entrante") return;

          // El nombre no viene en el mensaje. Una consulta chica por aviso es
          // barata: son unos pocos mensajes por hora.
          let quien = m.telefono;
          try {
            const { data } = await sb.from("pnr_conversaciones_mx")
              .select("conductor").eq("id", m.conversacion_id).maybeSingle();
            if (data && data.conductor) quien = data.conductor;
          } catch { /* se queda el teléfono */ }

          const resumen = m.texto
            ? m.texto.slice(0, 90)
            : { imagen: "envió una foto", audio: "envió una nota de voz",
                video: "envió un video", documento: "envió un documento",
                ubicacion: "compartió su ubicación" }[m.tipo_contenido] || "envió un adjunto";

          const aviso = { id: m.id, quien, resumen, caseId: m.case_id };
          setAvisos((prev) => [...prev.slice(-2), aviso]);
          if (cfg.current.activo) sonar(cfg.current.nivel);
          setTimeout(() => setAvisos((prev) => prev.filter((a) => a.id !== aviso.id)), VIDA_MS);
        })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, []);

  if (!avisos.length) return null;

  return (
    <div style={{
      position: "fixed", left: 16, bottom: 16, zIndex: 9997,
      display: "flex", flexDirection: "column", gap: 8, maxWidth: 340,
    }}>
      {avisos.map((a) => (
        <div key={a.id}
          onClick={() => { navegar("/posventa"); setAvisos((p) => p.filter((x) => x.id !== a.id)); }}
          style={{
            background: "#1a3a6b", color: "#fff", borderRadius: 10,
            borderLeft: "4px solid #F47B20", padding: "10px 14px", cursor: "pointer",
            boxShadow: "0 6px 22px rgba(0,0,0,.28)", lineHeight: 1.35,
          }}>
          <div style={{ fontSize: 10.5, color: "#F47B20", fontWeight: 700,
            textTransform: "uppercase", letterSpacing: 0.4 }}>
            Posventa{a.caseId ? ` · caso ${a.caseId}` : ""}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{a.quien}</div>
          <div style={{ fontSize: 12, color: "#bcd0ec" }}>{a.resumen}</div>
        </div>
      ))}
    </div>
  );
}
