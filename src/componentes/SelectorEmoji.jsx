import { useState, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR DE EMOJIS
//
// No es una lista completa a propósito: son los que se usan de verdad al
// hablarle a un conductor en ruta. Un selector con mil emojis obliga a buscar;
// veinte agrupados por intención se eligen de un vistazo.
// ═══════════════════════════════════════════════════════════════════════════

const GRUPOS = [
  { titulo: "Trato",     lista: ["👋", "🙏", "👍", "💪", "🙌", "😊", "🫡", "✅"] },
  { titulo: "Operación", lista: ["📦", "📍", "🚚", "🛣️", "🏠", "🔑", "📞", "📸", "🕐", "🗺️"] },
  { titulo: "Atención",  lista: ["⚠️", "🚨", "🛑", "❗", "🤔", "❌"] },
];

export default function SelectorEmoji({ onElegir, disabled }) {
  const [abierto, setAbierto] = useState(false);
  const cajaRef = useRef(null);

  // Cerrar al hacer clic afuera: sin esto el panel queda tapando el hilo.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (cajaRef.current && !cajaRef.current.contains(e.target)) setAbierto(false); };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [abierto]);

  return (
    <div ref={cajaRef} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setAbierto(!abierto)} disabled={disabled}
        title="Insertar emoji"
        style={{ padding: "9px 11px", fontSize: 15, lineHeight: 1 }}>
        😊
      </button>

      {abierto && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 50,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,.14)", padding: 10, width: 268,
        }}>
          {GRUPOS.map((g) => (
            <div key={g.titulo} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginBottom: 4 }}>
                {g.titulo}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                {g.lista.map((e) => (
                  <button key={e} onClick={() => { onElegir(e); setAbierto(false); }}
                    style={{
                      fontSize: 19, lineHeight: 1, padding: "4px 6px",
                      border: "none", background: "transparent", cursor: "pointer",
                      borderRadius: 6,
                    }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = "#f1f5f9")}
                    onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
