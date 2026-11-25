/** Pack de scripts Lua incluidos en el motor. Se activan desde Opciones → Scripts. */
export interface BuiltinScript { id: string; name: string; desc: string; src: string }

export const BUILTIN_SCRIPTS: BuiltinScript[] = [
  {
    id: 'gameover_plus', name: 'Game Over+', desc: 'Flash, temblor y texto al morir',
    src: `
function onGameOverStart()
  cameraFlash('other', 'FF0000', 0.5)
  cameraShake('other', 0.01, 0.4)
  makeLuaText('goTxt', 'GAME OVER', 1280, 0, 80)
  setTextSize('goTxt', 70)
  setTextAlignment('goTxt', 'center')
  setTextColor('goTxt', 'FF4444')
  setObjectCamera('goTxt', 'other')
  setProperty('goTxt.alpha', 0)
  addLuaText('goTxt')
  doTweenAlpha('goTxtIn', 'goTxt', 1, 1.2, 'quadOut')
end
function onGameOverConfirm(retry)
  if retry then doTweenAlpha('goTxtOut', 'goTxt', 0, 0.3, 'linear') end
end
`,
  },
  {
    id: 'bg_pulse', name: 'Pulso de fondo', desc: 'Destello suave del fondo en cada compás',
    src: `
function onCreatePost()
  makeLuaSprite('bgPulse', nil, 0, 0)
  makeGraphic('bgPulse', 1280, 720, 'FFFFFF')
  setObjectCamera('bgPulse', 'camHUD')
  setProperty('bgPulse.alpha', 0)
  addLuaSprite('bgPulse', false)
  setObjectOrder('bgPulse', 0)
end
function onBeatHit()
  if curBeat % 4 == 0 then
    setProperty('bgPulse.alpha', 0.12)
    doTweenAlpha('bgPulseT', 'bgPulse', 0, 0.45, 'quadOut')
  end
end
`,
  },
  {
    id: 'rain', name: 'Lluvia', desc: 'Gotas de lluvia sobre la pantalla',
    src: `
local N = 60
function onCreatePost()
  for i = 1, N do
    local t = 'rain' .. i
    makeLuaSprite(t, nil, getRandomInt(0, 1280), getRandomInt(0, 720))
    makeGraphic(t, 2, 22, 'AACCFF')
    setObjectCamera(t, 'camHUD')
    setProperty(t .. '.alpha', 0.35)
    setProperty(t .. '.angle', 8)
    addLuaSprite(t, true)
  end
end
function onUpdate(e)
  for i = 1, N do
    local t = 'rain' .. i
    local y = getProperty(t .. '.y') + 1400 * e
    local x = getProperty(t .. '.x') - 190 * e
    if y > 740 then y = -30; x = getRandomInt(0, 1400) end
    setProperty(t .. '.y', y); setProperty(t .. '.x', x)
  end
end
`,
  },
  {
    id: 'snow', name: 'Nieve', desc: 'Copos cayendo con vaivén',
    src: `
local N = 50
local t0 = 0
function onCreatePost()
  for i = 1, N do
    local t = 'snow' .. i
    local s = getRandomInt(3, 7)
    makeLuaSprite(t, nil, getRandomInt(0, 1280), getRandomInt(0, 720))
    makeGraphic(t, s, s, 'FFFFFF')
    setObjectCamera(t, 'camHUD')
    setProperty(t .. '.alpha', getRandomFloat(0.4, 0.9))
    addLuaSprite(t, true)
  end
end
function onUpdate(e)
  t0 = t0 + e
  for i = 1, N do
    local t = 'snow' .. i
    local y = getProperty(t .. '.y') + (50 + (i % 5) * 18) * e
    local x = getProperty(t .. '.x') + math.sin(t0 * 1.3 + i) * 30 * e
    if y > 730 then y = -10; x = getRandomInt(0, 1280) end
    setProperty(t .. '.y', y); setProperty(t .. '.x', x)
  end
end
`,
  },
  {
    id: 'vignette', name: 'Viñeta', desc: 'Bordes oscuros alrededor de la pantalla',
    src: `
function onCreatePost()
  for i = 1, 6 do
    local a = 0.09
    local sz = 30 * i
    local d = { {'vT'..i, 0, 0, 1280, sz}, {'vB'..i, 0, 720 - sz, 1280, sz}, {'vL'..i, 0, 0, sz, 720}, {'vR'..i, 1280 - sz, 0, sz, 720} }
    for _, v in ipairs(d) do
      makeLuaSprite(v[1], nil, v[2], v[3])
      makeGraphic(v[1], v[4], v[5], '000000')
      setObjectCamera(v[1], 'camHUD')
      setProperty(v[1] .. '.alpha', a)
      addLuaSprite(v[1], true)
    end
  end
end
`,
  },
  {
    id: 'camera_sway', name: 'Cámara con vaivén', desc: 'La cámara se inclina suavemente',
    src: `
local t0 = 0
function onUpdate(e)
  t0 = t0 + e
  setProperty('camGame.angle', math.sin(t0 * 0.8) * 0.7)
end
`,
  },
  {
    id: 'icon_wobble', name: 'Iconos con rebote', desc: 'Los iconos se inclinan al ritmo',
    src: `
local dir = 1
function onBeatHit()
  dir = -dir
  setProperty('iconP1.angle', 12 * dir)
  setProperty('iconP2.angle', -12 * dir)
  doTweenAngle('wob1', 'iconP1', 0, 0.3, 'quadOut')
  doTweenAngle('wob2', 'iconP2', 0, 0.3, 'quadOut')
end
`,
  },
  {
    id: 'health_drain', name: 'Drenar vida', desc: 'El oponente te quita vida al golpear (no mata)',
    src: `
function opponentNoteHit(id, dir, type, sus)
  local h = getHealth()
  if h > 0.2 then setHealth(h - (sus and 0.005 or 0.02)) end
end
`,
  },
  {
    id: 'ms_display', name: 'Mostrar ms', desc: 'Muestra el desfase en ms de cada nota',
    src: `
function onCreatePost()
  makeLuaText('msTxt', '', 400, 440, 300)
  setTextSize('msTxt', 32)
  setTextAlignment('msTxt', 'center')
  setObjectCamera('msTxt', 'camHUD')
  addLuaText('msTxt')
end
function goodNoteHit(id, dir, type, sus)
  if sus then return end
  local ms = math.floor(getPropertyFromGroup('notes', id, 'strumTime') - getSongPosition())
  setTextString('msTxt', (ms > 0 and '+' or '') .. ms .. ' ms')
  setTextColor('msTxt', math.abs(ms) < 45 and '66FF66' or (math.abs(ms) < 90 and 'FFFF66' or 'FF6666'))
  setProperty('msTxt.alpha', 1)
  cancelTween('msFade')
  doTweenAlpha('msFade', 'msTxt', 0, 0.6, 'linear')
end
`,
  },
  {
    id: 'miss_flash', name: 'Flash al fallar', desc: 'Destello rojo y sacudida al fallar una nota',
    src: `
function noteMiss(id, dir, type, sus)
  cameraFlash('camHUD', 'FF0000', 0.15)
  cameraShake('camGame', 0.004, 0.12)
end
`,
  },
];
