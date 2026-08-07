import { useState, useEffect, useRef } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// CERRAR INCIDENCIA CON MOTIVO
//
// Antes se cerraba con un botón único que escribía estado 'CLOSED' sin
// sub-estado: un motivo que no existe en MELI. Ahora se elige del catálogo real
// del portal (crm_cierre_motivos), así el cierre de la torre habla el mismo
// idioma que el de MELI y se pueden comparar.
//
// La nota es opcional pero vale: cuando la torre y MELI cierran con motivos
// distintos, es lo único que explica por qué.
// ═══════════════════════════════════════════════════════════════════════════

export default function CerrarConMotivo({ caso, onCerrar }) {
  const [abierto, setAbierto] = useState(false);
  const [motivos, setMotivos] = useState([]);
  const [elegido, setElegido] = useState("");
  const [nota, setNota] = useState("");
  const [cerrando, setCerrando] = useState(false);
  const cajaRef = useRef(null);

  useEffect(() => {
    sb.from("crm_cierre_motivos").select("clave, etiqueta, descripcion")
      .eq("activo", true).order("orden")
      .then(({ data }) => setMotivos(data || []));
  }, []);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (cajaRef.current && !cajaRef.current.contains(e.target)) setAbierto(false); };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [abierto]);

  async function confirmar() {
    if (!elegido || cerrando) return;
    setCerrando(true);
    await onCerrar(caso, elegido, nota);
    setCerrando(false);
    setAbierto(false);
    setElegido(""); setNota("");
  }

  return (
    <div ref={cajaRef} style={{ position: "relative", flexShrink: 0 }}>
      <button className="btn-naranja" onClick={() => setAbierto(!abierto)}
        style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>
        Cerrar ticket
      </button>

      {abierto && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 60,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,.16)", padding: 14, width: 330,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>
            ¿Con qué motivo se cierra?
          </div>
          <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 10, lineHeight: 1.45 }}>
            Son los mismos motivos que usa MELI. Si el portal lo cierra después con otro,
            queda registrado el de la torre y se puede comparar.
          </div>

          {motivos.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--texto-tenue)" }}>
              Cargando motivos… (si no aparecen, falta correr cierre_con_motivo.sql)
            </div>
          ) : (
            <>
              {motivos.map((m) => (
                <label key={m.clave} style={{
                  display: "block", padding: "7px 9px", marginBottom: 4,
                  border: `1px solid ${elegido === m.clave ? "var(--navy)" : "var(--borde)"}`,
                  background: elegido === m.clave ? "#eef2f7" : "#fff",
                  borderRadius: 8, cursor: "pointer",
                }}>
                  <input type="radio" name="cierre" value={m.clave}
                    checked={elegido === m.clave}
                    onChange={() => setElegido(m.clave)}
                    style={{ marginRight: 7 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{m.etiqueta}</span>
                  {m.descripcion && (
                    <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginLeft: 21, marginTop: 1 }}>
                      {m.descripcion}
                    </div>
                  )}
                </label>
              ))}

              <input value={nota} onChange={(e) => setNota(e.target.value)}
                placeholder="Nota (opcional)"
                style={{
                  width: "100%", boxSizing: "border-box", fontSize: 12,
                  padding: "7px 9px", marginTop: 6,
                  border: "1px solid var(--borde)", borderRadius: 8,
                }} />

              <div style={{ display: "flex", gap: 7, justifyContent: "flex-end", marginTop: 10 }}>
                <button onClick={() => setAbierto(false)} style={{ fontSize: 12, padding: "7px 12px" }}>
                  Cancelar
                </button>
                <button className="btn-naranja" onClick={confirmar} disabled={!elegido || cerrando}
                  style={{ fontSize: 12, padding: "7px 14px" }}>
                  {cerrando ? "Cerrando…" : "Cerrar"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
