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
  - 🔤 Transcripción fonética + botón 🔊 para escuchar la pronunciación
  - 🇪🇸 Traducción al español
  - 📖 Definiciones y ejemplos en inglés
- **Ayuda con frases** — selecciona varias palabras y traduce la frase completa.
- **Índice de capítulos** — el desplegable de navegación muestra los títulos reales del libro (leídos del índice del EPUB), no «Sección 7 de 41». Salta a cualquier capítulo de un toque.
- **Vocabulario con repaso** — guarda palabras y frases con ⭐; las guardadas quedan subrayadas mientras lees. Repásalas con **tarjetas y repetición espaciada** (algoritmo SM-2 simplificado): cada palabra vuelve a aparecer justo antes de que la olvides. El contador junto a ⭐ te dice cuántas tocan hoy. Exportables a CSV.
- **Comodidad de lectura** — temas claro ☀️ / sepia 📜 / oscuro 🌙, tamaño de texto ajustable y navegación con flechas ← →.
- **Memoria** — tu biblioteca, tu progreso y tu vocabulario se guardan en el navegador. Recuerda por dónde ibas en cada libro.
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
2. **Android (Chrome):** pulsa el botón **⬇️ Instalar**, o menú ⋮ → *Añadir a pantalla de inicio*.
3. **iPhone (Safari):** botón *Compartir* → *Añadir a pantalla de inicio*.

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
| Definiciones en inglés | [Free Dictionary API](https://dictionaryapi.dev) |
| Traducción inglés → español | [MyMemory Translation API](https://mymemory.translated.net) |
| Lectura de archivos `.epub` | [JSZip](https://stuk.github.io/jszip/) |
| Pronunciación 🔊 | Web Speech API del navegador |
| Estadísticas de uso | [Google Tag Manager](https://tagmanager.google.com) (`GTM-5ZB7JTBC`), con Google Analytics 4 configurado dentro |

> ⚠️ La traducción gratuita de MyMemory tiene un límite diario generoso pero no infinito. Si algún día deja de traducir, suele ser por la cuota.

---

## 📁 Estructura

```
index.html              · La aplicación completa (UI + lógica)
manifest.webmanifest    · Metadatos de la PWA
sw.js                   · Service worker (cache offline)
icon-192.png            · Iconos de la app
icon-512.png
icon-maskable-512.png
apple-touch-icon.png
favicon.png
```

---

## 🔒 Privacidad

Tus libros, tu progreso y tu vocabulario se guardan **solo en tu navegador** — los libros en IndexedDB (sin el límite de ~5 MB de `localStorage`) y el resto en `localStorage`. No hay servidor propio ni cuentas: el texto de tus libros no sale nunca de tu dispositivo.

> 💡 Como todo vive en el navegador, borrar los datos del sitio se lo lleva todo. Usa **💾 Copia** de vez en cuando.

Peticiones externas que sí se hacen:

- Las consultas de **definición y traducción** de las palabras y frases que tocas.
- **Google Tag Manager** (`GTM-5ZB7JTBC`), que carga Google Analytics 4 para medir visitas de forma agregada. No se le envía ni el contenido de tus libros ni tu vocabulario. Un bloqueador de rastreadores lo desactiva sin afectar al resto de la app.

---

Hecho con ❤️ para aprender inglés leyendo.
