# The Eyes

Ticketera operativa de incidencias en ruta de Bigticket. Si el Brain piensa y decide, The Eyes observa y actúa: las analistas de la torre toman casos de MELI, contactan al conductor y resuelven en tiempo real.

Comparte la misma base Supabase que el Brain (`crm_inc_casos`, `crm_inc_historial`, `crm_analistas`, `crm_inc_asignaciones`, `crm_motivos_catalogo`). Aquí solo vive el frontend; la ingesta de casos corre en n8n/VPS.

## Stack

- Vite + React 18
- React Router 6
- Supabase JS (auth + datos)
- Fuente Geist · colores navy `#1a3a6b` / naranja `#F47B20`

## Puesta en marcha local

```bash
npm install
cp .env.example .env     # completa VITE_SUPABASE_ANON_KEY
npm run dev              # http://localhost:5173
```

## Variables de entorno

| Variable | Qué es |
|---|---|
| `VITE_SUPABASE_URL` | URL del proyecto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Anon key pública (la seguridad la da RLS) |

## Despliegue en Vercel

1. Sube este repo a GitHub.
2. En Vercel: New Project → importa el repo.
3. Framework preset: Vite (se detecta solo).
4. Agrega las dos variables de entorno en Settings → Environment Variables.
5. Deploy. El `vercel.json` ya maneja el rewrite de rutas para la SPA.

## Estructura

```
src/
  main.jsx              punto de entrada (router + auth provider)
  App.jsx               enrutado y protección de sesión
  estilos.css           estilos globales y tokens de marca
  shared/
    supabase.js         cliente Supabase
    auth.jsx            contexto de sesión + perfil del analista
    constantes.js       colores, estados, prioridades, grupos
    fechas.js           helpers de tiempo
  componentes/
    Topbar.jsx          barra superior
    ColaTickets.jsx     lista de incidencias abiertas
    HiloTicket.jsx      conversación + acciones (tomar/resolver)
    PanelContexto.jsx   conductor, métricas de ruta, comprador efímero
  modulos/
    Login.jsx           acceso con Supabase Auth
    Ticketera.jsx       vista principal de tres columnas
```

## Estado actual (scaffold inicial)

Funciona: login real, carga de la cola desde `crm_inc_casos`, tomar y resolver tickets vía las RPC (`fn_tomar_ticket`, `fn_resolver_ticket`), panel de contexto con conductor y comprador efímero, refresco automático cada 30s.

Pendiente (siguientes pasos): mensajería WhatsApp bidireccional, panel de desempeño del analista, copilot de IA, y el botón "pasar número al chofer" conectado al flujo de envío.

## Habilitar un analista

Un usuario debe existir en Supabase Auth y estar registrado en `crm_analistas`:

```sql
insert into crm_analistas (user_id, nombre, email, rol, pais)
values ('<user_id de auth.users>', 'Nombre Apellido', 'correo@bigticket.cl', 'analista', 'MX');
```
