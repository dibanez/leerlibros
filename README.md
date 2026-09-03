# 📖 LeerLibros

Un lector de libros en **inglés** que te ayuda con las palabras y frases que no entiendes. Toca cualquier palabra para ver su **pronunciación, traducción al español y definición**; o selecciona una frase para traducirla entera. Todo en una sola página web, gratis y sin claves de API.

Es una **PWA instalable**: puedes añadirla a la pantalla de inicio de tu móvil y usarla como una app normal, a pantalla completa.

### 👉 Pruébala en vivo: **[dibanez.github.io/leerlibros](https://dibanez.github.io/leerlibros/)**

---

## ✨ Características

- **Carga tus libros** de tres formas:
  - ✏️ Pegando texto
  - 📂 Subiendo archivos `.txt`
  - 📚 Subiendo archivos `.epub` (se extrae el texto y los nombres de los capítulos)
- **Ayuda con palabras** — toca una palabra y obtienes:
  - 🔤 Transcripción fonética + botón 🔊 con **grabación de voz humana** cuando el diccionario la tiene (si no, voz sintética)
  - 🇪🇸 Traducción al español
  - 📖 Definiciones y ejemplos en inglés
  - 🔁 Si tocas una palabra conjugada (`running`, `went`, `children`), la busca por su forma base y te dice cuál ha encontrado
- **Ayuda con frases** — selecciona varias palabras y traduce la frase completa.
- **Índice de capítulos** — el desplegable de navegación muestra los títulos reales del libro (leídos del índice del EPUB), no «Sección 7 de 41». Salta a cualquier capítulo de un toque.
- **Vocabulario con contexto** — guarda palabras y frases con ⭐ y se guarda con ellas **todo lo que tenías en pantalla**: la transcripción fonética, la definición, la grabación y **la frase del libro donde la encontraste**. Si tocaste una forma conjugada (`went`), se archiva bajo su forma base (`go`), así que `gone` y `going` no se convierten en tres tarjetas distintas. Las guardadas quedan subrayadas mientras lees, y **las que tocan hoy se resaltan** para que te las vuelvas a encontrar en una frase de verdad.
- **Práctica de verdad, no solo tarjetas** — el repaso se endurece a medida que la palabra se te afianza:
  - 🔢 **Test** con opciones sacadas de tu propio vocabulario, para el primer encuentro.
  - ⌨️ **Escribir** la palabra en inglés: producirla, no solo reconocerla. Se corrige sola, ignorando tildes y mayúsculas, y perdonando una letra cambiada de sitio.
  - ␣ **Hueco**: completar la frase del libro con la palabra que falta.
  - 👂 **Dictado**: la oyes y la escribes.
  - 🔁 **Tarjeta** clásica, **en los dos sentidos** (🇬🇧→🇪🇸).
  Puedes fijar un tipo concreto desde ⚙️ Ajustes o desde el propio repaso. Desde cualquier tarjeta, **📖 Ver en el libro** te lleva a la página donde la encontraste.
- **Repetición espaciada que se sostiene** — SM-2 simplificado con **fase de aprendizaje** (una palabra nueva se ve dos veces en la misma sesión antes de programarse a días), **límite de palabras nuevas al día** y **tope por sesión**: guardar cincuenta palabras en un capítulo no te deja cincuenta tarjetas a la mañana siguiente. Una palabra que fallas una y otra vez se pone **en pausa** en lugar de repetirse eternamente, y puedes reactivarla cuando quieras.
- **Saber que estás avanzando** — racha de días seguidos, palabras guardadas, pendientes de hoy y aprendidas. Y la lista se puede **buscar, filtrar** (pendientes, sin repasar, aprendiendo, aprendidas, las que se te resisten, frases) **y ordenar**. Exportable a CSV con su contexto y su calendario.
- **Comodidad de lectura** — temas claro ☀️ / sepia 📜 / oscuro 🌙, y en ⚙️ tamaño de texto, **tipografía** (serif / sans / alta legibilidad), **interlineado** y **ancho de columna**. Navegación con flechas ← →.
- **Buscar dentro del libro** — 🔎 encuentra cualquier palabra o frase, te enseña en qué capítulo está y con qué contexto, y salta hasta ella resaltándola.
- **Accesible con teclado** — selecciona una palabra o frase en el texto y pulsa **Intro** para consultarla. Los diálogos toman y devuelven el foco, y el resultado se anuncia a los lectores de pantalla.
- **Memoria** — tu biblioteca, tu progreso y tu vocabulario se guardan en el navegador. Recuerda por dónde ibas en cada libro, **incluso a media sección**: al volver, sigues justo donde lo dejaste.
- **Copias de seguridad** — 💾 exporta biblioteca, vocabulario y preferencias a un archivo `.json`, y ♻️ restáuralo en otro dispositivo o después de borrar los datos del navegador. Al restaurar se **añade** a lo que ya tengas, nunca se sobrescribe.
- **Funciona sin conexión** — la interfaz se cachea mediante un *service worker*, y **cada palabra consultada se guarda**: las que ya has mirado se abren al instante y siguen funcionando sin internet. Solo las palabras nuevas necesitan conexión.

---

## 🚀 Uso

### En el ordenador
Abre `index.html` en tu navegador. Para que el modo PWA / service worker funcione, sírvelo por HTTP en lugar de abrir el archivo directamente:

```bash
python3 -m http.server 8000
# luego abre http://localhost:8000
```

### En el móvil (instalar como app)
1. Abre **[dibanez.github.io/leerlibros](https://dibanez.github.io/leerlibros/)** en el navegador del móvil.
2. Pulsa el botón **⬇️ Instalar** de la barra superior.
   - En **Android/Chrome** aparece el diálogo de instalación del navegador.
   - En **iPhone** no existe ese diálogo (Safari no lo implementa, y en iOS todos
     los navegadores son Safari por dentro), así que el botón te muestra los pasos:
     *Compartir* → *Añadir a pantalla de inicio*.

Quedará con su icono propio y se abrirá a pantalla completa.

---

## 🌐 Publicar en GitHub Pages

Esta app está publicada en **[dibanez.github.io/leerlibros](https://dibanez.github.io/leerlibros/)**. Para desplegar tu propia copia:

1. Crea un repositorio vacío en GitHub (sin README).
2. Sube el código:
   ```bash
   git remote add origin https://github.com/TU-USUARIO/leerlibros.git
   git push -u origin main
   ```
3. En el repo: **Settings → Pages → Source: "Deploy from a branch"** → rama `main`, carpeta `/ (root)`.
4. En ~1 minuto estará disponible en `https://TU-USUARIO.github.io/leerlibros/`.

---

## 🛠️ Cómo funciona

| Necesidad | Servicio (gratuito, sin clave) |
|-----------|-------------------------------|
| Definiciones en inglés | [Free Dictionary API](https://dictionaryapi.dev), con [Wiktionary](https://en.wiktionary.org) de respaldo |
| Traducción inglés → español | [MyMemory Translation API](https://mymemory.translated.net) |
| Lectura de archivos `.epub` | [JSZip](https://stuk.github.io/jszip/) |
| Pronunciación 🔊 | Web Speech API del navegador |
| Estadísticas de uso | [Google Tag Manager](https://tagmanager.google.com) (`GTM-5ZB7JTBC`), con Google Analytics 4 configurado dentro |

> ⚠️ La traducción gratuita de MyMemory tiene un límite diario generoso pero no infinito. Cuando se agota, la app te lo dice con claridad en vez de fallar en silencio, y te ofrece ampliarlo.
>
> Para ampliarlo, pon tu correo en **⚙️ Ajustes → Traducción**. MyMemory concede un límite bastante mayor a las consultas identificadas. **Cada persona pone el suyo**: se guarda solo en su dispositivo y no está en el código.

---

## 📁 Estructura

```
index.html              · Estructura de la página
app.css                 · Todos los estilos
app.js                  · Toda la lógica
gtm.js                  · Arranque de Google Tag Manager
analytics.js            · Eventos de uso hacia el dataLayer
sw.js                   · Service worker (cache offline)
vendor/jszip.min.js     · JSZip 3.10.1, servido desde el propio sitio
manifest.webmanifest    · Metadatos de la PWA
sitemap.xml             · Sitemap para buscadores
robots.txt              · Solo útil si algún día sirves la app desde la raíz de un dominio
icon-*.png              · Iconos de la app
favicon.png
apple-touch-icon.png
og-image.png            · Imagen de previsualización al compartir el enlace
screenshot-*.png        · Capturas para la ficha de instalación
tools/og-template.html  · Plantilla con la que se genera og-image.png
tests/                  · Suite de Playwright
```

No hay ningún paso de compilación: los ficheros que ves son los que se sirven.

---

## 🧪 Desarrollo y tests

```bash
npm install                     # solo la primera vez
npx playwright install chromium # solo la primera vez
npm test                        # 53 tests en ~10 s
npm run test:ui                 # modo interactivo
npm run serve                   # sirve la app en localhost:8000
```

Los tests levantan un servidor estático y conducen un Chromium real: cubren el
lector, la carga de EPUB con su índice, el caché de consultas, el repaso con
repetición espaciada, IndexedDB, las copias de seguridad, el funcionamiento sin
conexión y los metadatos. **No tocan la red**: las APIs de diccionario y
traducción están simuladas, así que la suite es determinista y también pasa
estando desconectado. Se ejecutan solos en cada push mediante GitHub Actions.

---

## 🔐 Seguridad

La página va con una **Content-Security-Policy** estricta, sin `unsafe-inline`
ni `unsafe-eval`: no queda ni un `<script>` ni un `onclick` ni un `style=""`
incrustado. Los botones se manejan con `data-action` y un único listener.

> ⚠️ Si añades una etiqueta **HTML personalizada** en Tag Manager, la CSP la
> bloqueará. Las etiquetas normales (GA4 y demás) funcionan sin tocar nada.

---

## 🔒 Privacidad

Tus libros, tu progreso y tu vocabulario se guardan **solo en tu navegador** — los libros en IndexedDB (sin el límite de ~5 MB de `localStorage`) y el resto en `localStorage`. No hay servidor propio ni cuentas: **el texto completo de tus libros no se sube a ninguna parte**.

> 💡 Como todo vive en el navegador, borrar los datos del sitio se lo lleva todo. Usa **💾 Copia** de vez en cuando.

Peticiones externas que sí se hacen:

- Las consultas de **definición y traducción** de las palabras y frases que tocas.
- **Google Tag Manager** (`GTM-5ZB7JTBC`), que carga Google Analytics 4. Además de las visitas, `analytics.js` mide cómo se usa la app: temas, tamaño de letra, cambios de sección, tiempo de lectura, altas y bajas de libros, y acciones de vocabulario.

  **No se carga hasta que aceptas el aviso de cookies.** Si lo rechazas no se pide nada a Google ni se guarda ninguna cookie suya, y la app funciona igual. Puedes cambiar de opinión en **⚙️ Ajustes → Cookies**.

- Si has puesto tu correo en Ajustes, viaja a **MyMemory** junto a cada traducción, para identificar la consulta y ampliar el límite. No se envía a ningún otro sitio.

---

## ❤️ Apoyar el proyecto

La app es gratis, sin anuncios y sin cuentas. Si te resulta útil, hay un botón
de donación al pie de la biblioteca: **[paypal.me/dibanez1979](https://www.paypal.com/paypalme/dibanez1979)**.

---

Hecho con ❤️ para aprender inglés leyendo.
