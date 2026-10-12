# Queue-Bypass

Abre varias ventanas de navegador (Chrome, Edge, Brave, Opera, Firefox), cada una en versión normal y privada, todas apuntando al sitio de Boca Socios y acomodadas en grilla sobre la pantalla. Cada ventana tiene su propia sesión, así que cada una obtiene **su propio lugar en la fila virtual de Queue-it**. Cuando una ventana pasa la fila, el script cierra todas las demás.

Plataforma: Ubuntu 26.04 con GNOME (Wayland + XWayland).

## Instalación

```bash
npm install
npx playwright install firefox   # Firefox propio de Playwright (el Snap de Ubuntu no sirve)
```

Además se necesitan `xrandr` y `xprop` (para detectar la pantalla) y `pkill`. Los navegadores tienen que estar instalados en las rutas que espera `open-browsers.js`. Esas rutas están detalladas en `CLAUDE.md`.

## Uso

```bash
node open-browsers.js                       # 1 ventana normal + 1 privada por navegador
node open-browsers.js --chrome 2 --opera 0  # 2 normales de Chrome, sin Opera
node open-browsers.js --private 0           # sin ventanas privadas
node open-browsers.js --keep-all            # no cerrar las demás al pasar la fila
```

| Flag | Significado |
|---|---|
| `--<navegador> N` | Ventanas normales de ese navegador (por defecto 1, `0` lo omite) |
| `--private N` | Ventanas privadas por navegador (por defecto 1) |
| `--url URL` | URL inicial (por defecto `https://bocasocios.bocajuniors.com.ar/home`) |
| `--screen WxH+X+Y` | Área de pantalla para la grilla (por defecto se detecta sola) |
| `--keep-all` | Desactiva el cierre automático de ventanas |

`Ctrl+C` cierra todas las ventanas y borra los perfiles temporales de `.profiles/`.

## Cómo funciona el proceso de compra

Intervienen dos servicios distintos, y se comportan de forma muy diferente:

| | Fila virtual | API de entradas |
|---|---|---|
| Host | `bocajuniors.queue-it.net` | `bocasocios-gw.bocajuniors.com.ar` |
| Quién lo opera | Queue-it | Boca, detrás del WAF de Huawei Cloud (cookie `HWWAFSESID`) |
| Qué consulta | `/spa-api/queue/.../status`, la posición en la fila | `/event/v2/buy/additional/order/validate/...` cada ~10 s, la disponibilidad |
| ¿Bloqueó con muchas ventanas? | No se observaron problemas | **Sí**, bloqueo por IP |

Flujo:

1. La ventana abre `bocasocios.bocajuniors.com.ar` y el sitio la redirige a `bocajuniors.queue-it.net`.
2. En la fila, la ventana solo habla con Queue-it. Cada ventana tiene una posición y un tiempo de espera distintos.
3. Al llegarle el turno, Queue-it la devuelve al sitio de Boca, pasando por `bocasocios-gw.../queueit/redirect`, con la cookie `QueueITAccepted-...`. **Esa cookie es de esa ventana:** copiar la URL a otra ventana no conserva el turno.
4. Ya en el sitio, la página consulta `validate` cada ~10 s. Desde este momento cada ventana genera tráfico contra el WAF.

## El bloqueo (418 / "CORS error")

Síntoma: en la consola del navegador, el `GET` a `validate` aparece como **CORS error**, y el `OPTIONS` previo responde **`418 I'm a teapot`**. En el caso que observamos duró unos 10 minutos y después se resolvió solo.

Qué pasa realmente:

- **El 418 lo devuelve el WAF**, no la API: así responde el WAF de Huawei Cloud cuando bloquea.
- **El error CORS es una consecuencia del bloqueo.** El WAF responde el preflight (`OPTIONS`) sin cabeceras `Access-Control-Allow-*`, y por eso el navegador cancela el `GET`. La API nunca recibe la petición.
- **El bloqueo es por IP.** El `OPTIONS` no lleva cookies ni el header `Authorization`, así que lo único que identifica al cliente es la IP (y el User-Agent).
- **Afecta a todas las ventanas a la vez,** porque todas salen por la misma IP pública.
- **El umbral es desconocido.** Lo configura Boca y puede cambiar, sobre todo en días de venta. El WAF cuenta todo el tráfico hacia sus hosts, no solo `validate`: carga de páginas, assets y demás endpoints.

## Bloqueo de los endpoints de asientos

También se observó un bloqueo distinto, más acotado, **usando un solo navegador**. Al abrir una sección de plateas (`/matches/<evento>/plateas/seats/<sección>`), la página llama a dos endpoints:

- `GET /event/seat/section/<sección>/locations`: el mapa de asientos de la sección.
- `GET /event/seat/section/<sección>/availability`: qué asientos están libres.

Esos dos devolvieron `418` en el preflight, igual que antes. Pero **en el mismo segundo y desde la misma IP**, otras peticiones respondían bien: `/event/<evento>/seat/section/availability` (disponibilidad general de todas las secciones) y `/member/shoppingCart/<evento>`. Las respuestas 418 traen `server: CloudWAF` y tardan ~530 ms, contra ~30 ms de las que pasan.

Conclusiones:

- **No es un bloqueo de toda la IP:** el WAF está limitando solo los endpoints de una sección de asientos, los más costosos para el servidor.
- **La página reintenta sola** (a los ~1,5 s, 2,5 s y 4,5 s), y cada reintento cuenta para el límite.
- **No sabemos la causa exacta.** Hay tres posibilidades:
  - un límite por IP con umbral bajo en esos endpoints (por ejemplo, después de entrar y salir de varias secciones);
  - una **IP compartida (CGNAT)**: muchos proveedores en Argentina comparten la misma IP pública entre muchos clientes, así que otros usuarios suman al mismo contador;
  - una regla general que Boca aplica a todos cuando el servidor está saturado.

Qué hacer:

- **Dejá de tocar esa sección y no recargues.** Volvé al listado y esperá unos minutos: cada intento extiende el bloqueo.
- **Tené una sola pestaña del sitio abierta.**
- **Entrá directo a la sección que te interesa**, en vez de recorrer varias.
- **Para saber si el problema es tuyo o general,** pedile a alguien con otra conexión que abra la misma sección al mismo tiempo. Si a esa persona le anda, el límite es por IP (tuya o compartida). Si a esa persona también le falla, el problema es del sistema.

## Cómo evitar el bloqueo

1. **Una sola sesión después de la fila, como máximo dos.** Pasada la fila, todas las ventanas ven el mismo stock: más sesiones consultando no consiguen entradas antes, solo suman tráfico. Si salta el bloqueo, caen todas, incluida la buena.
2. **Dejá activo el cierre automático** (no uses `--keep-all`). Cuando una pestaña pasa de Queue-it al sitio de Boca, el script cierra las demás ventanas en aproximadamente un segundo, antes de que también pasen la fila y empiecen a consultar `validate`.
3. **Mientras están en la fila, las ventanas no generan riesgo,** porque solo consultan Queue-it. Podés cerrar a mano las que tengan mucho tiempo de espera y quedarte con las de menor espera.
4. **No abras demasiadas ventanas a la vez.** La carga inicial de cada ventana también pasa por los hosts de Boca. Si aparece un 418 apenas arrancás, la causa es esa: abrí menos.
5. **Si aparece un 418, bajá la carga enseguida.** Cerrá ventanas. Seguir consultando durante el bloqueo probablemente lo extienda.
6. **Evitá comprar en paralelo con la misma cuenta.** Lo más probable es que el sistema permita un solo pedido por socio, y varias ventanas comprando pueden pisarse.

## Limitaciones del cierre automático

- **Firefox privado no puede ganar.** El script no puede leer la URL de esas ventanas: si pasan la fila primero no se detecta, aunque sí se cierran cuando gana otra. Para no depender de esto, usá `--firefox 0` o `--private 0`.
- **Las ventanas privadas de Chromium abren un puerto de depuración en `127.0.0.1`** para que el script lea sus pestañas. Solo es accesible desde la propia máquina y desaparece al cerrarlas.
- **Si dos ventanas pasan la fila en el mismo segundo,** gana la primera que encuentra el script y la otra se cierra.
- Los hosts que se vigilan están en `QUEUE_HOST` y `SITE_HOST` en `open-browsers.js`. Si Boca cambia de dominio, hay que actualizarlos.

## Seguridad de la cuenta

El header `Authorization: Bearer ...` que se ve en las herramientas de desarrollador es una credencial válida por ~24 h: contiene tu email y número de socio. Al compartir capturas o comandos `curl`, borralo antes. Los archivos HAR exportados del navegador lo incluyen en cada petición, junto con todas las cookies de sesión (también las de Queue-it): no los compartas. Si se filtró, cerrá sesión en el sitio.
