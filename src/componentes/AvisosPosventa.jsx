import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../shared/supabase.js";
import { useSonidoPnr, sonarPnr } from "../shared/sonido-pnr.js";

// ═══════════════════════════════════════════════════════════════════════════
// AVISOS DEL CANAL DE POSVENTA
//
// Aparecen abajo a la IZQUIERDA, con un sonido distinto al de la torre. Los dos
// canales atienden cosas que no se parecen: la torre es un conductor en ruta
// con un problema ahora, Posventa es un reclamo de una entrega de hace dos
// días. Que suenen igual obliga a mirar la pantalla para saber cuál es urgente.
//
// El sonido se genera con WebAudio en vez de un archivo: dos notas descendentes,
// más graves y más lentas que el aviso de la torre. Vive en shared/sonido-pnr.js
// porque también lo usa la campana al probar el volumen.
//
// El volumen es propio, con su campana P en el Topbar. Un analista que está
// peleando tickets en vivo quiere la torre en "Fuerte" y Posventa en "Suave", y
// con un solo control tenía que elegir.
// ═══════════════════════════════════════════════════════════════════════════

const VIDA_MS = 12000;   // más que el de la torre: acá no hay que reaccionar ya

export default function AvisosPosventa() {
  const [avisos, setAvisos] = useState([]);
  const navegar = useNavigate();
  const sonido = useSonidoPnr();
  // Se lee por referencia para que el canal de Realtime no se rearme cada vez
  // que el analista cambia el volumen.
  const cfg = useRef(sonido);
  cfg.current = sonido;

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
          if (cfg.current.activo) sonarPnr(cfg.current.nivel);
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
