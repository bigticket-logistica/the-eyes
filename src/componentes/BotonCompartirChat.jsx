import { useState } from "react";
import { compartirTicketEnChat } from "../shared/chat.js";

// ═══════════════════════════════════════════════════════════════════════════
// Botón "Compartir al chat" · publica el ticket en la pestaña Mensajes.
// Un clic abre un campo de nota opcional; el resumen del ticket lo arma solo.
// ═══════════════════════════════════════════════════════════════════════════

export default function BotonCompartirChat({ caso, analistaId, compacto }) {
  const [abierto, setAbierto] = useState(false);
  const [nota, setNota] = useState("");
  const [estado, setEstado] = useState(null);   // null | "enviando" | "listo" | mensaje de error

  async function enviar() {
    setEstado("enviando");
    try {
      await compartirTicketEnChat({ analistaId, caso, nota: nota.trim() || null });
      setEstado("listo");
      setNota("");
      setAbierto(false);
      setTimeout(() => setEstado(null), 2500);
    } catch (e) {
      setEstado(e.message);
    }
  }

  if (!caso?.case_id) return null;

  if (estado === "listo") {
    return <span style={{ fontSize: 11.5, color: "#15803d", whiteSpace: "nowrap" }}>✓ Compartido</span>;
  }

  if (!abierto) {
    return (
      <button
        onClick={() => { setAbierto(true); setEstado(null); }}
        title="Publicar este ticket en el chat de la torre"
        style={{ fontSize: 11.5, padding: compacto ? "3px 9px" : "5px 11px", whiteSpace: "nowrap" }}>
        💬 Compartir al chat
      </button>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      background: "#f8fafc", border: "1px solid var(--borde)",
      borderRadius: 8, padding: "5px 7px",
    }}>
      <input
        autoFocus value={nota}
        onChange={(e) => setNota(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") enviar();
          if (e.key === "Escape") { setAbierto(false); setNota(""); }
        }}
        placeholder="Nota para el equipo (opcional)…"
        style={{
          width: 210, fontSize: 12, padding: "5px 8px",
          border: "1px solid var(--borde)", borderRadius: 6,
        }} />
      <button className="btn-navy" onClick={enviar} disabled={estado === "enviando"}
        style={{ fontSize: 11.5, padding: "5px 11px", whiteSpace: "nowrap" }}>
        {estado === "enviando" ? "…" : "Publicar"}
      </button>
      <button onClick={() => { setAbierto(false); setNota(""); setEstado(null); }}
        style={{ fontSize: 11.5, padding: "5px 8px" }}>✕</button>
      {estado && estado !== "enviando" && (
        <span style={{ fontSize: 11, color: "#bb4444", maxWidth: 160 }}>{estado}</span>
      )}
    </div>
  );
}
