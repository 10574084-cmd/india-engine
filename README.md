# India Engine

Motor de **Friday Night Funkin'** para el navegador (TypeScript + Canvas + WebAudio + Lua vía wasmoon) con
soporte de mods estilo Psych 0.7.x: charts JSON, personajes Sparrow, stages JSON/Lua, eventos, tipos de nota,
scripts Lua con la API de Psych, mods en `.zip` o carpeta.

## Cómo usarlo

```bash
npm install
npm run extract -- ruta/a/FNF-PsychEngine-0.7.3.zip   # extrae assets/ a public/ (solo desarrollo local)
npm run dev                                           # http://localhost:5173
```

También puedes **no** extraer nada y, ya en la página, usar los botones de la barra superior (pasa el ratón
arriba): *Cargar assets base (.zip)*, *Agregar mod (.zip)* o *Agregar mod (carpeta)*. Arrastrar un `.zip` sobre
la ventana también funciona. Los assets del juego base **no están en este repositorio**.

`npm run build` genera la versión estática en `dist/`.

## Controles
`A S W D` o flechas para las notas · `Enter` aceptar · `Esc` pausa/volver · `R` reiniciar (mata la run).

## Qué está implementado
- Reloj de canción sobre `AudioContext` (sincronía precisa), cambios de BPM, cuenta atrás, pausa, game over, reintento.
- Notas con sustains, ventanas Sick/Good/Bad/Shit, puntuación, combo, salud, rating, splashes, ghost tapping, botplay, downscroll, middlescroll.
- Notas coloreadas por paleta RGB (equivalente al shader de Psych), `disableNoteRGB`, `arrowSkin`, `splashSkin`.
- Personajes (`characters/*.json`, atlas Sparrow, offsets, `danceLeft/danceRight`, miss, `-alt`, `Change Character`).
- Stages: JSON + `stages/<nombre>.lua`. Escenario `stage` (semana 1) nativo.
- Eventos: Hey!, Set GF Speed, Add Camera Zoom, Camera Follow Pos, Alt Idle Animation, Screen Shake, Play Animation,
  Change Scroll Speed, Change Character, Set Property, Play Sound y cualquier `custom_events/*.lua`.
- Tipos de nota: Hurt Note, Alt Animation, No Animation, GF Sing, Hey! y `custom_notetypes/*.lua`.
- Lua (wasmoon): ~200 funciones de la API (sprites, texto, tweens, timers, cámaras, propiedades, sonido, save data...)
  y los callbacks `onCreate`, `onCreatePost`, `onUpdate`, `onBeatHit`, `onStepHit`, `onSectionHit`, `onEvent`,
  `goodNoteHit`, `noteMiss`, `opponentNoteHit`, `onSpawnNote`, `onSongStart`, `onEndSong`, `onGameOver`, `onTweenCompleted`, `onTimerCompleted`...
- Mods: `.zip`/carpeta con detección automática de raíz, `pack.json` (`runsGlobally`), búsqueda sin distinguir mayúsculas.

## Limitaciones conocidas (hoja de ruta)
- **HScript** (`.hx`) y `runHaxeCode`: no soportado.
- **Shaders** (`initLuaShader`, `setSpriteShader`...): se ignoran con aviso.
- **Videos/cutscenes/diálogos**: se omiten (la canción arranca directo).
- **Atlas Animate** (`loadAnimateAtlas`), reflexión Haxe (`createInstance`, `callMethod`), substates custom: no soportado.
- Escenarios vanilla que eran código Haxe (spooky, philly, limo, mall, school, tank) usan un fondo neutro; los mods traen los suyos en Lua.
- Notas pixel (week 6) y modo historia/menús completos: pendientes.
- Un mod muy scripteado puede fallar en funciones concretas: los errores de Lua salen en pantalla y en la consola.

Mira `NOTICE.md` para los créditos y licencias.
