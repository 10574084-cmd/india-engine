export interface BPMChange { stepTime: number; songTime: number; bpm: number; stepCrochet: number }

/** Reloj musical: traduce milisegundos <-> steps/beats con cambios de BPM (igual que Conductor.hx de Psych). */
export class Conductor {
  bpm = 100;
  crochet = 600;
  stepCrochet = 150;
  songPosition = 0;
  bpmChangeMap: BPMChange[] = [];
  /** 10 frames a 60fps, ventana máxima de acierto */
  safeZoneOffset = (10 / 60) * 1000;

  setBPM(b: number) { this.bpm = b; this.crochet = (60 / b) * 1000; this.stepCrochet = this.crochet / 4; }
  static calcCrochet(bpm: number) { return (60 / bpm) * 1000; }

  mapBPMChanges(song: { bpm: number; notes: { changeBPM?: boolean; bpm?: number; sectionBeats?: number; lengthInSteps?: number }[] }) {
    this.bpmChangeMap = [];
    let cur = song.bpm, steps = 0, pos = 0;
    song.notes.forEach(sec => {
      if (sec.changeBPM && sec.bpm && sec.bpm !== cur) {
        cur = sec.bpm;
        this.bpmChangeMap.push({ stepTime: steps, songTime: pos, bpm: cur, stepCrochet: Conductor.calcCrochet(cur) / 4 });
      }
      const d = Math.round((sec.sectionBeats ?? (sec.lengthInSteps ? sec.lengthInSteps / 4 : 4)) * 4);
      steps += d;
      pos += ((60 / cur) * 1000 / 4) * d;
    });
  }

  private lastChangeAtTime(t: number): BPMChange {
    let last: BPMChange = { stepTime: 0, songTime: 0, bpm: this.bpm, stepCrochet: this.stepCrochet };
    for (const c of this.bpmChangeMap) if (t >= c.songTime) last = c;
    return last;
  }
  private lastChangeAtStep(s: number): BPMChange {
    let last: BPMChange = { stepTime: 0, songTime: 0, bpm: this.bpm, stepCrochet: this.stepCrochet };
    for (const c of this.bpmChangeMap) if (c.stepTime <= s) last = c;
    return last;
  }
  getStep(t: number) { const c = this.lastChangeAtTime(t); return c.stepTime + (t - c.songTime) / c.stepCrochet; }
  getBeat(t: number) { return this.getStep(t) / 4; }
  beatToSeconds(beat: number) {
    const step = beat * 4, c = this.lastChangeAtStep(step);
    return c.songTime + ((step - c.stepTime) / (c.bpm / 60) / 4) * 1000;
  }
  crochetAt(t: number) { return this.lastChangeAtTime(t).stepCrochet * 4; }
}
