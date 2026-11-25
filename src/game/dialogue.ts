import { Camera, Drawable, Sprite, TextObj, W, H } from '../engine/display';
import type { Engine } from '../engine/engine';
import { Track } from '../engine/audio';

export interface DialogueLine { portrait?: string | null; expression?: string | null; text?: string | null; boxState?: string | null; speed?: number | null; sound?: string | null }
export interface DialogueFile { dialogue: (DialogueLine | null)[] }
interface DAnim { anim: string; loop_name: string; loop_offsets: number[]; idle_name: string; idle_offsets: number[] }
interface DCharFile { image: string; dialogue_pos: 'left' | 'center' | 'right'; no_antialiasing?: boolean; animations: DAnim[]; position: number[]; scale: number }

const IDLE = '-IDLE';
const SCROLL = 4000, OFFSET_POS = -600;
const TEXT_X = 175, TEXT_Y = 460, LONG_ADD = 24;

class DChar extends Sprite {
  dAnims = new Map<string, DAnim>();
  startingPos = 0;
  constructor(public name: string, public json: DCharFile) { super(0, 0); }
  playDialogue(anim: string | null | undefined, playIdle = false) {
    let a = anim ?? '';
    if (!a || !this.dAnims.has(a)) { const all = [...this.dAnims.keys()]; if (all.length) a = all[Math.floor(Math.random() * all.length)]; }
    const d = this.dAnims.get(a);
    if (d && (!d.loop_name || d.loop_name === d.idle_name)) playIdle = true;
    this.play(playIdle ? a + IDLE : a, true);
    if (d) { const o = playIdle ? d.idle_offsets : d.loop_offsets; this.offset.x = o?.[0] ?? 0; this.offset.y = o?.[1] ?? 0; } else { this.offset.x = 0; this.offset.y = 0; }
  }
  get isLoop() { return !!this.cur && !this.cur.name.endsWith(IDLE); }
}

/** Cuadro de diálogo estilo DialogueBoxPsych. */
export class DialogueBox implements Drawable {
  camera = 'other'; visible = true;
  finishThing: () => void = () => {};
  nextDialogueThing: ((line: number) => void) | null = null;
  skipDialogueThing: ((line: number) => void) | null = null;
  done = false;
  private fade = 0; private fadeVisible = true;
  private box: Sprite | null;
  private chars: DChar[] = [];
  private text = new TextObj(TEXT_X, TEXT_Y, 0, '', 36);
  private full = ''; private shown = 0; private delay = 0.05; private acc = 0; private finishedText = false; private sound = 'dialogue';
  private cur = 0; private last = -1; private lastType = ''; private ended = false; private ignoreFirst = true;
  private buf = new Map<string, AudioBuffer | null>();
  private music: Track | null = null;

  private constructor(private e: Engine, private list: DialogueFile, box: Sprite) {
    this.box = box;
    this.text.color = 0x3F2021; this.text.font = 'vcr';
  }

  static async create(e: Engine, list: DialogueFile, musicName?: string): Promise<DialogueBox> {
    const a = e.assets;
    const boxAtlas = await a.atlas('speech_bubble');
    const box = new Sprite(70, 370);
    if (boxAtlas) {
      box.setAtlas(boxAtlas);
      const add = (n: string, p: string, loop = true) => box.addByPrefix(n, p, 24, loop);
      add('normal', 'speech bubble normal'); add('normalOpen', 'Speech Bubble Normal Open', false);
      add('angry', 'AHH speech bubble'); add('angryOpen', 'speech bubble loud open', false);
      add('center-normal', 'speech bubble middle'); add('center-normalOpen', 'Speech Bubble Middle Open', false);
      add('center-angry', 'AHH Speech Bubble middle'); add('center-angryOpen', 'speech bubble Middle loud open', false);
      box.play('normal', true);
      box.scale.x = box.scale.y = 0.9; box.updateHitbox();
    }
    box.scrollFactor.x = box.scrollFactor.y = 0; box.visible = false; box.antialiasing = e.prefs.antialiasing; box.camera = 'other';
    const d = new DialogueBox(e, list, box);
    d.fade = 0;
    for (const n of ['dialogue', 'dialogueClose']) d.buf.set(n, await a.sound(n));
    // personajes
    const seen: string[] = [];
    for (const l of list.dialogue) if (l && l.portrait != null && !seen.includes(l.portrait)) seen.push(l.portrait);
    if (!seen.length) seen.push('bf');
    for (const name of seen) {
      const json = (await a.json<DCharFile>(`images/dialogue/${name}.json`)) ?? (await a.json<DCharFile>('images/dialogue/bf.json'))!;
      const c = new DChar(name, json);
      const at = await a.atlas('dialogue/' + json.image); if (at) c.setAtlas(at);
      for (const an of json.animations ?? []) { c.addByPrefix(an.anim, an.loop_name, 24, false); c.addByPrefix(an.anim + IDLE, an.idle_name, 24, true); c.dAnims.set(an.anim, an); }
      c.antialiasing = e.prefs.antialiasing && !json.no_antialiasing;
      c.scale.x = c.scale.y = 0.7 * (json.scale ?? 1); c.updateHitbox();
      c.scrollFactor.x = c.scrollFactor.y = 0; c.alpha = 0.00001; c.camera = 'other';
      let x = -60 + OFFSET_POS, y = 60; const pos = json.position ?? [0, 0];
      if (json.dialogue_pos === 'center') { x = W / 2 - c.width / 2; y = H + 50; c.x = x; c.y = y; c.startingPos = pos[1] + 60; c.x += pos[0]; c.y += pos[1]; }
      else {
        if (json.dialogue_pos === 'right') { const sx = W - c.width - 100; c.x = sx - OFFSET_POS; c.startingPos = sx + pos[0]; }
        else { c.x = x; c.startingPos = -60 + pos[0]; }
        c.y = y; c.x += pos[0]; c.y += pos[1];
      }
      d.chars.push(c);
    }
    if (musicName) {
      const b = await a.music(musicName);
      if (b) { d.music = e.audio.track(b, true); d.music.play(0); d.music.fade(1, 2, 0); }
    }
    d.startNext();
    return d;
  }

  private snd(name: string, vol = 1) { const b = this.buf.get(name); if (b) this.e.audio.playSound(b, vol); else void this.e.assets.sound(name).then(x => { this.buf.set(name, x); if (x) this.e.audio.playSound(x, vol); }); }

  private wrap(t: string) {
    const c = document.createElement('canvas').getContext('2d')!; c.font = this.text.fontStr();
    const out: string[] = [];
    for (const para of t.split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        const test = line ? line + ' ' + w : w;
        if (c.measureText(test).width > W - TEXT_X * 2 + 60 && line) { out.push(line); line = w; } else line = test;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  private boxOffsets() {
    const b = this.box; if (!b) return;
    b.centerOffsets(); b.updateHitbox();
    const n = b.animName;
    if (n.startsWith('angry')) { b.offset.x = 50; b.offset.y = 65; }
    else if (n.startsWith('center-angry')) { b.offset.x = 50; b.offset.y = 30; }
    else { b.offset.x = 10; b.offset.y = 0; }
    if (!b.flipX) b.offset.y += 10;
  }

  private startNext() {
    let line: DialogueLine | null = null;
    while (this.cur < this.list.dialogue.length && !(line = this.list.dialogue[this.cur])) this.cur++;
    if (!line) { this.ended = true; return; }
    const text = line.text && line.text.length ? line.text : ' ';
    const type = line.boxState === 'angry' ? 'angry' : 'normal';
    const delay = line.speed == null || isNaN(line.speed) ? 0.05 : line.speed;
    let ci = this.chars.findIndex(c => c.name === line!.portrait); if (ci < 0) ci = 0;
    const ch = this.chars[ci];
    const prefix = ch?.json.dialogue_pos === 'center' ? 'center-' : '';
    const b = this.box!; b.visible = true;
    if (ci !== this.last) { b.play(prefix + type + 'Open', true); b.flipX = ch?.json.dialogue_pos === 'left'; this.boxOffsets(); }
    else if (type !== this.lastType) { b.play(prefix + type, true); this.boxOffsets(); }
    this.last = ci; this.lastType = type;
    this.full = this.wrap(text); this.shown = 0; this.acc = 0; this.delay = delay; this.finishedText = false;
    this.sound = line.sound && line.sound.trim() ? line.sound : 'dialogue';
    this.text.y = TEXT_Y - (this.full.split('\n').length > 2 ? LONG_ADD : 0);
    this.text.text = '';
    if (ch) {
      ch.playDialogue(line.expression, false);
      if (ch.cur) { let r = 24 - (((delay - 0.05) / 5) * 480); r = Math.min(48, Math.max(12, r)); ch.cur.fps = r; }
    }
    this.cur++;
    this.nextDialogueThing?.(this.cur);
  }

  update(dt: number) {
    if (this.ignoreFirst) { this.ignoreFirst = false; return; }
    const inp = this.e.input;
    this.box?.update(dt);
    for (const c of this.chars) c.update(dt);
    if (!this.ended) {
      this.fade = Math.min(0.5, this.fade + 0.5 * dt);
      // texto tecleado
      if (!this.finishedText) {
        this.acc += dt; let played = false;
        while (this.acc >= this.delay && !this.finishedText) {
          this.shown++;
          if (!played && this.sound && (this.delay > 0.025 || this.shown % 2 === 0)) this.snd(this.sound);
          played = true; this.acc = 0;
          if (this.shown >= this.full.length) { this.finishedText = true; }
          if (this.delay <= 0) { this.shown = this.full.length; this.finishedText = true; }
        }
        this.text.text = this.full.slice(0, this.shown);
      }
      if (inp.justPressed('accept') || inp.mouseJustPressed(0)) {
        if (!this.finishedText) { this.shown = this.full.length; this.text.text = this.full; this.finishedText = true; this.skipDialogueThing?.(this.cur); }
        else if (this.cur >= this.list.dialogue.length) {
          this.ended = true;
          const b = this.box!; const n = b.animName;
          for (const pre of ['', 'center-']) for (const t of ['normal', 'angry']) if (n === pre + t || n === pre + t + 'Open') b.play(pre + t + 'Open', true);
          if (b.cur) { b.curFrame = b.cur.frames.length - 1; b.reversed = true; b.finished = false; }
          this.boxOffsets();
          this.text.text = '';
          this.music?.fade(0, 1);
        } else this.startNext();
        this.snd('dialogueClose');
      } else {
        const c = this.chars[this.last];
        if (c && c.cur && c.finished) { if (this.finishedText && c.isLoop) c.playDialogue(c.cur.name, true); else if (!this.finishedText) c.play(c.cur.name, true); }
      }
      const b = this.box!;
      if (b.cur && b.finished) {
        for (const pre of ['', 'center-']) for (const t of ['normal', 'angry']) if (b.animName === pre + t || b.animName === pre + t + 'Open') b.play(pre + t, true);
        this.boxOffsets();
      }
      this.chars.forEach((c, i) => {
        const pos = c.json.dialogue_pos;
        const active = i === this.last;
        const dir = active ? 1 : -1;
        if (pos === 'left') { c.x += dir * SCROLL * dt; if (active) c.x = Math.min(c.x, c.startingPos); else c.x = Math.max(c.x, c.startingPos + OFFSET_POS); }
        else if (pos === 'center') { c.y -= dir * SCROLL * dt; if (active) c.y = Math.max(c.y, c.startingPos); else c.y = Math.min(c.y, c.startingPos + H); }
        else { c.x -= dir * SCROLL * dt; if (active) c.x = Math.max(c.x, c.startingPos); else c.x = Math.min(c.x, c.startingPos - OFFSET_POS); }
        c.alpha = Math.min(1, Math.max(0.00001, c.alpha + dir * 3 * dt));
      });
    } else if (!this.done) {
      const b = this.box;
      if (b && b.curFrame <= 0) { this.box = null; }
      if (this.fadeVisible) { this.fade -= 0.5 * dt; if (this.fade <= 0) { this.fade = 0; this.fadeVisible = false; } }
      for (const c of this.chars) {
        if (c.json.dialogue_pos === 'left') c.x -= SCROLL * dt; else if (c.json.dialogue_pos === 'center') c.y += SCROLL * dt; else c.x += SCROLL * dt;
        c.alpha -= dt * 10;
      }
      if (!this.box && !this.fadeVisible) { this.done = true; this.music?.stop(); this.music?.destroy(); this.finishThing(); }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (this.done) return;
    if (this.fade > 0.001) { ctx.save(); ctx.globalAlpha = this.fade * cam.alpha; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    for (const c of this.chars) c.draw(ctx, cam);
    this.box?.draw(ctx, cam);
    if (!this.ended) this.text.draw(ctx, cam);
  }
}
