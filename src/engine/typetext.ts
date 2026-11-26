import { TextObj } from './display';

/** FlxTypeText: texto que se escribe letra por letra. */
export class TypeText extends TextObj {
  _finalText = '';
  _length = 0;
  paused = false;
  typing = false;
  delay = 0.05;
  private timer = 0;
  sounds: { play?: (force?: boolean) => any }[] = [];
  completeCallback: (() => void) | null = null;
  shadowOffset = { x: 1, y: 1, set(x: number, y = x) { this.x = x; this.y = y; } };
  skipKeys: string[] = [];

  resetText(t: string) { this._finalText = String(t ?? ''); this._length = 0; this.text = ''; this.typing = false; this.timer = 0; this.paused = false; }
  start(delay = 0.05, _forceRestart = false) { this.delay = delay || 0.05; this.typing = true; this.timer = 0; if (this._length === 0) this.text = ''; }
  skip() { this._length = this._finalText.length; this.text = this._finalText; this.finish(); }
  private finish() { if (this.typing) { this.typing = false; this.completeCallback?.(); } }
  update(dt: number) {
    if (this.typing && !this.paused) {
      this.timer += dt;
      let added = false;
      while (this.timer >= this.delay && this._length < this._finalText.length) { this.timer -= this.delay; this._length++; added = true; }
      if (added) { this.text = this._finalText.slice(0, this._length); const snd = this.sounds[Math.floor(Math.random() * this.sounds.length)]; try { snd?.play?.(true); } catch { /* sonido */ } }
      if (this._length >= this._finalText.length) this.finish();
    } else if (this._length !== this.text.length) this.text = this._finalText.slice(0, this._length);
    super.update?.(dt);
  }
}
