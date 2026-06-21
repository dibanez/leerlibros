# 📖 LeerLibros

Un lector de libros en **inglés** que te ayuda con las palabras y frases que no entiendes. Toca cualquier palabra para ver su **pronunciación, traducción al español y definición**; o selecciona una frase para traducirla entera. Todo en una sola página web, gratis y sin claves de API.

Es una **PWA instalable**: puedes añadirla a la pantalla de inicio de tu móvil y usarla como una app normal, a pantalla completa.

---

## ✨ Características

- **Carga tus libros** de tres formas:
  - ✏️ Pegando texto
  - 📂 Subiendo archivos `.txt`
  - 📚 Subiendo archivos `.epub` (se extrae el texto automáticamente)
- **Ayuda con palabras** — toca una palabra y obtienes:
  - 🔤 Transcripción fonética + botón 🔊 para escuchar la pronunciación
  - 🇪🇸 Traducción al español
  - 📖 Definiciones y ejemplos en inglés
- **Ayuda con frases** — selecciona varias palabras y traduce la frase completa.
- **Vocabulario** — guarda palabras y frases con ⭐; las guardadas quedan subrayadas mientras lees. Repásalas y expórtalas a CSV.
- **Comodidad de lectura** — temas claro ☀️ / sepia 📜 / oscuro 🌙, tamaño de texto ajustable y navegación con flechas ← →.
- **Memoria** — tu biblioteca, tu progreso y tu vocabulario se guardan en el navegador (`localStorage`). Recuerda por dónde ibas en cada libro.
- **Funciona sin conexión** — la interfaz se cachea mediante un *service worker*. (Las traducciones y definiciones sí necesitan internet.)

---

## 🚀 Uso

### En el ordenador
Abre `index.html` en tu navegador. Para que el modo PWA / service worker funcione, sírvelo por HTTP en lugar de abrir el archivo directamente:

```bash
python3 -m http.server 8000
# luego abre http://localhost:8000
```

### En el móvil (instalar como app)
1. Abre la URL publicada (ver más abajo) en el navegador del móvil.
2. **Android (Chrome):** pulsa el botón **⬇️ Instalar**, o menú ⋮ → *Añadir a pantalla de inicio*.
3. **iPhone (Safari):** botón *Compartir* → *Añadir a pantalla de inicio*.

Quedará con su icono propio y se abrirá a pantalla completa.

---

## 🌐 Publicar en GitHub Pages

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

Tus libros, tu progreso y tu vocabulario se guardan **solo en tu navegador**. No hay servidor propio ni cuentas. Las únicas peticiones externas son las consultas de definición y traducción de las palabras que tocas.

---

Hecho con ❤️ para aprender inglés leyendo.
