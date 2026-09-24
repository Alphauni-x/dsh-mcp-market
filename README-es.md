# dsh-mcp-market

**Explora, escanea y sincroniza el mercado MCP de ModelScope dentro de DeepSeek Harness — e instala,
activa, desactiva o elimina servidores MCP con un clic.**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Añade un panel **Mercado MCP** a la barra lateral de DSH Web. Obtiene el catálogo de
[modelscope.cn/mcp](https://modelscope.cn/mcp) (más de 12.000 servicios), traduce cada registro a una
configuración MCP compatible con DSH y la escribe en el `cordis.patch.yml` de tu perfil, donde DSH la
recarga en caliente mediante HMR.

## Features

- **Pestaña Mercado** — buscar, ordenar (relevancia / estrellas / popularidad / actualización
  reciente), filtrar por categoría y por alojado o local, e instalar. Los nombres de categoría son las
  etiquetas chinas de ModelScope (la API solo devuelve slugs en inglés; las 100 categorías vienen
  incluidas) — pasa el cursor por una para ver el slug original. El orden y los filtros usan el menú
  desplegable nativo de DSH, así que combinan con los botones de al lado.
- **Pestaña Instalados** — cada servidor MCP con su estado en vivo (en ejecución / fallido /
  cargando / desactivado), número de herramientas registradas y acciones: activar, desactivar,
  probar conexión, eliminar.
- **Sincronización del catálogo** — crea un índice local para que buscar, ordenar y filtrar no golpee
  la red en cada pulsación. ModelScope limita las consultas anónimas a 300 filas, así que la
  sincronización recorre un abanico de palabras clave (~160 peticiones) y alcanza ~67 % del catálogo
  de 12.500 servicios; el panel informa la cobertura real en lugar de fingir que el índice está
  completo. Las diferencias incrementales indican qué se añadió, actualizó o retiró.
  La búsqueda cierra el resto: al escribir una consulta también se pregunta al mercado en vivo.
- **Sincronización programada** — además del botón manual, el índice se vuelve a descargar
  automáticamente cada cierto intervalo, y al arrancar si la caché falta o está obsoleta. Todo es
  configurable y el panel muestra cuándo fue la última y cuándo será la próxima.
- **Sin cuenta de ModelScope** — la API pública no requiere inicio de sesión y cerca del 76 % de los
  servicios indexados incluyen una configuración que DSH puede usar directamente (medición sobre
  8.377 registros; véase más abajo).
- **Compatible con otros complementos** — solo reescribe su propio bloque marcado en
  `cordis.patch.yml`; las filas de otros complementos se conservan byte a byte.

## Install

```bash
dsh plugin --profile web add dsh-mcp-market
```

Reinicia el perfil web una vez y abre **Mercado MCP** en la barra lateral izquierda.

## How it works

Un servidor MCP es una fila en `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mcp-market-<serverName>
  name: "@deepseek-ai/dsh-mcp-client"
  # disabled: true          # ← «desactivar» es exactamente este campo
  config:
    serverName: <serverName>
    transport: stdio | streamable-http
```

Instalar añade una fila, eliminar la quita y desactivar pone `disabled: true`. Los cambios surten
efecto por HMR.

Los despliegues **alojados** de ModelScope requieren una cuenta y devuelven una dirección SSE que DSH
no admite; este complemento no los soporta a propósito.

### Mapeo de configuración

| Campo de ModelScope | Configuración de DSH |
|---|---|
| `StreamableHTTPServerConfig` | `transport: streamable-http` + `url` (+ `headers`) |
| `ServerConfig` | `transport: stdio` + `command` / `args` / `env` |
| `SSEServerConfig` | *no admitido* — DSH no tiene transporte SSE; el panel los marca como «no admitido» |
| `EnvSchema` | formulario en la instalación; los valores de relleno como `<required>` nunca se escriben |

La prioridad es remoto → local. Medido sobre los 8.377 registros del índice:

| Configuración encontrada | Proporción |
|---|---|
| `ServerConfig` (local, stdio) | 67,5 % |
| `StreamableHTTPServerConfig` (dirección directa) | 8,4 % |
| Solo `SSEServerConfig` → **no instalable** | 24,1 % |

**El 75,9 % de los servicios indexados son instalables**; el 23,4 % necesita al menos una variable de
entorno.

### Por qué el índice se detiene en ~67 %, y qué hace realmente la sincronización

La API pública impone un **tope de desplazamiento de 300 para peticiones anónimas**: cuando
`(PageNumber − 1) × PageSize` llega a 300, todas las páginas siguientes vuelven vacías *y* `TotalCount`
cae a 0. Medido con 11 combinaciones de ancho de página y número de página, el corte está siempre
exactamente en 300, así que es una cuota del servidor y no un error de paginación. Una sincronización
que solo pagina hasta agotar se detiene en 300 de 12.520 servicios (2,4 %).

Lo que sí funciona es `Query`: es una búsqueda real por palabra clave (`finance` → 20 resultados,
`搜索` → 222). Así que la sincronización recorre un abanico de palabras clave (las 26 letras, 10
dígitos, ~50 términos comunes y los nombres de categoría del propio catálogo) y une los resultados por id:

| Palabras clave | Indexados | Cobertura | Peticiones |
|---|---|---|---|
| 36 (letras + dígitos) | 7.132 | 57,0 % | 100 |
| 80 | 8.331 | 66,6 % | ~155 |
| 160 | 8.403 | 67,1 % | 236 |

El rendimiento se aplana rápido — las últimas 80 palabras aportaron 72 registros — así que la lista
por defecto se detiene en 96. Una sincronización tarda unos 4 minutos y ~160 peticiones.

La brecha restante se cubre al buscar: al escribir una consulta, el panel también pregunta al mercado
en vivo y combina ambos conjuntos de resultados.

## Scheduled sync

Dos disparadores comparten el mismo bloqueo: una sincronización manual y una programada nunca
coinciden.

| Disparador | Cuándo | Por defecto |
|---|---|---|
| **Manual** | Al pulsar **Sincronizar catálogo** | siempre disponible |
| **Arranque** | Una vez por arranque, solo si la caché falta o supera las 6 horas | activo, 15 s tras arrancar |
| **Intervalo** | Cada `intervalHours` mientras DSH se ejecuta | cada 24 h |

Añada una fila con el **mismo `id`** al `cordis.patch.yml` de su perfil; la capa del perfil tiene
prioridad y un patch reemplaza todo el `config`, así que reescriba cada clave que quiera conservar:

```yaml
- id: mcp-market
  name: dsh-mcp-market
  config:
    autoSync: false        # desactiva por completo el intervalo
    intervalHours: 12      # 0.25 – 168
    syncOnStart: true
    startDelayMs: 30000
    maxRequests: 400       # presupuesto de peticiones del abanico de palabras clave
```

Los cambios se recargan en caliente por HMR. La línea de estado del panel siempre muestra la
programación actual y la última sincronización. Los temporizadores están ligados a la vida del
complemento y se cancelan al descargarlo.

## Compatibility

| Superficie | Estado |
|---|---|
| DeepSeek Harness | `0.1.7-rc.1` (verificado) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Plataformas | Todas (ESM puro, sin código nativo) |
| Modelo | Cualquiera (sin interacción con modelos) |

## Development

```bash
node test/patch.test.mjs         # seguridad del archivo de configuración
node test/market.test.mjs        # filtrado, conversión, comparación + catálogo en vivo
node test/scheduler.test.mjs     # programación de sincronización: límites, ciclo de vida, concurrencia
node test/keywords.test.mjs      # abanico de palabras clave + el tope anónimo de 300
node test/status.test.mjs        # estado del loader, fase de fiber, número de herramientas
node test/client-render.test.mjs # renderiza el bundle de cliente sin navegador + guardas de código
node test/wire-contract.test.mjs # paridad manifest ↔ contribución + nombres reservados
```

`market.test.mjs` y `keywords.test.mjs` necesitan red; use `SKIP_ONLINE=1` para ejecutar solo sus
secciones offline.

## Uninstall

```bash
dsh plugin --profile web remove dsh-mcp-market
```

Los servidores que instaló permanecen en `cordis.patch.yml` (son filas MCP normales de DSH).
Elimínelos desde la pestaña Instalados si quiere dejar el archivo limpio.

## License

MIT
