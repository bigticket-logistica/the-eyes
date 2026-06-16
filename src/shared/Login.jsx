import { useState } from "react";
import { useAuth } from "../shared/auth.jsx";

export default function Login() {
  const { entrar } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  async function enviar() {
    setError("");
    if (!email || !password) { setError("Escribe tu correo y contraseña."); return; }
    setCargando(true);
    const { error } = await entrar(email.trim(), password);
    setCargando(false);
    if (error) setError("No pudimos iniciar sesión. Revisa tus datos.");
  }

  return (
    <div style={{
      height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--navy)", padding: 24,
    }}>
      <div style={{
        background: "#fff", borderRadius: 16, padding: "36px 32px",
        width: "100%", maxWidth: 380,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, background: "var(--naranja)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 700, fontSize: 18,
          }}>◉</div>
          <span style={{ fontSize: 20, fontWeight: 700, color: "var(--navy)" }}>The Eyes</span>
        </div>
        <p style={{ color: "var(--texto-suave)", fontSize: 13, marginBottom: 24 }}>
          Torre de soporte · incidencias en ruta
        </p>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 6 }}>Correo</label>
        <input
          type="email" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enviar()}
          placeholder="tu.correo@bigticket.cl"
          style={{ marginBottom: 16 }}
        />

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 6 }}>Contraseña</label>
        <input
          type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enviar()}
          placeholder="••••••••"
          style={{ marginBottom: error ? 10 : 20 }}
        />

        {error && (
          <div style={{ color: "#b91c1c", fontSize: 12, marginBottom: 16 }}>{error}</div>
        )}

        <button className="btn-naranja" onClick={enviar} disabled={cargando}
          style={{ width: "100%", padding: "11px", fontSize: 14 }}>
          {cargando ? "Entrando…" : "Entrar"}
        </button>
      </div>
    </div>
  );
}
