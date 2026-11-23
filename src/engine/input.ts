import { Prefs } from './save';

/** Teclado: estado por acción (left/down/up/right/accept/back/pause/reset). */
export class Input {
  private down = new Set<string>();
  private pressedFrame = new Set<string>();
  private releasedFrame = new Set<string>();
  /** cola de pulsaciones con marca de tiempo, para juzgar notas en el momento exacto de la pulsación */
  queue: { code: string; time: number; down: boolean }[] = [];
  onRawKey?: (code: string, down: boolean, ev: KeyboardEvent) => void;
  constructor(public prefs: Prefs) {
    window.addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code); this.pressedFrame.add(e.code);
      this.queue.push({ code: e.code, time: performance.now(), down: true });
      this.onRawKey?.(e.code, true, e);
    });
    window.addEventListener('keyup', e => {
      this.down.delete(e.code); this.releasedFrame.add(e.code);
      this.queue.push({ code: e.code, time: performance.now(), down: false });
      this.onRawKey?.(e.code, false, e);
    });
    window.addEventListener('blur', () => this.down.clear());
  }
  codes(action: string): string[] { return this.prefs.keys[action] ?? []; }
  actionOf(code: string): string[] {
    return Object.entries(this.prefs.keys).filter(([, v]) => v.includes(code)).map(([k]) => k);
  }
  pressed(action: string) { return this.codes(action).some(c => this.down.has(c)); }
  justPressed(action: string) { return this.codes(action).some(c => this.pressedFrame.has(c)); }
  justReleased(action: string) { return this.codes(action).some(c => this.releasedFrame.has(c)); }
  rawDown(code: string) { return this.down.has(code); }
  justPressedRaw(code: string) { return this.pressedFrame.has(code); }
  endFrame() { this.pressedFrame.clear(); this.releasedFrame.clear(); this.queue.length = 0; }
}
