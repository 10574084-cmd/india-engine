/**
 * Intérprete de un subconjunto amplio de Haxe (el que usan los scripts HScript de Psych).
 * Lexer -> parser (AST) -> evaluador. Los valores son valores JS normales, de modo que los
 * objetos del motor (sprites, cámaras...) se usan directamente desde el script.
 */

// ============================================================================ errores y señales
export class HxError extends Error { constructor(msg: string, public line = 0) { super(line ? `${msg} (línea ${line})` : msg); } }
class Break { } class Continue { }
class Return { constructor(public v: any) { } }
class Thrown { constructor(public v: any) { } }

// ============================================================================ preprocesador (#if ...)
const DEFINES = new Set(['MODS_ALLOWED', 'LUA_ALLOWED', 'HSCRIPT_ALLOWED', 'VIDEOS_ALLOWED', 'ACHIEVEMENTS_ALLOWED', 'PSYCH', 'html5', 'web', 'desktop', 'INDIA']);
function evalCond(c: string): boolean {
  const toks = c.match(/!|\(|\)|&&|\|\||[A-Za-z_]\w*/g) ?? [];
  let i = 0;
  const prim = (): boolean => {
    const t = toks[i++];
    if (t === '!') return !prim();
    if (t === '(') { const v = or(); i++; return v; }
    return DEFINES.has(t);
  };
  const and = (): boolean => { let v = prim(); while (toks[i] === '&&') { i++; const r = prim(); v = v && r; } return v; };
  const or = (): boolean => { let v = and(); while (toks[i] === '||') { i++; const r = and(); v = v || r; } return v; };
  return or();
}
export function preprocess(src: string): string {
  const out: string[] = [];
  const stack: { active: boolean; taken: boolean; parent: boolean }[] = [];
  let active = true;
  for (const line of src.split('\n')) {
    const m = /^\s*#(if|elseif|else|end)\b(.*)$/.exec(line);
    if (!m) { out.push(active ? line : ''); continue; }
    out.push('');
    const [, d, rest] = m;
    if (d === 'if') { const parent = active; const c = parent && evalCond(rest); stack.push({ active: c, taken: c, parent }); active = c; }
    else if (d === 'elseif') { const s = stack[stack.length - 1]; if (!s) continue; const c = s.parent && !s.taken && evalCond(rest); if (c) s.taken = true; s.active = c; active = c; }
    else if (d === 'else') { const s = stack[stack.length - 1]; if (!s) continue; const c = s.parent && !s.taken; s.taken = true; s.active = c; active = c; }
    else { const s = stack.pop(); active = s ? s.parent : true; }
  }
  return out.join('\n');
}

// ============================================================================ lexer
type Tok = { t: 'num' | 'str' | 'istr' | 'id' | 'op' | 'eof' | 'regex'; v: any; line: number; pos: number; flags?: string };
const OPS = ['>>>=', '<<=', '>>=', '...', '??=', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '=>', '->'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (t: Tok['t'], v: any, pos: number) => toks.push({ t, v, line, pos });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '@') { // metadatos: @:keep, @:access(...)
      i++; if (src[i] === ':') i++;
      while (i < n && /[\w.]/.test(src[i])) i++;
      if (src[i] === '(') { let d = 0; do { if (src[i] === '(') d++; else if (src[i] === ')') d--; i++; } while (i < n && d > 0); }
      continue;
    }
    if (c === '~' && src[i + 1] === '/') { // literal de expresión regular ~/patrón/flags
      let j = i + 2, body = '';
      while (j < n && src[j] !== '/') { if (src[j] === '\\') { body += src[j] + (src[j + 1] ?? ''); j += 2; } else body += src[j++]; }
      j++; let fl = ''; while (/[a-z]/.test(src[j] ?? '')) fl += src[j++];
      toks.push({ t: 'regex', v: body, line, pos: i, flags: fl }); i = j; continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) { i += 2; while (/[0-9a-fA-F]/.test(src[i] ?? '')) i++; push('num', parseInt(src.slice(start, i), 16), start); continue; }
      while (/[0-9]/.test(src[i] ?? '')) i++;
      if (src[i] === '.' && src[i + 1] !== '.' && /[0-9]/.test(src[i + 1] ?? '')) { i++; while (/[0-9]/.test(src[i] ?? '')) i++; }
      if ((src[i] === 'e' || src[i] === 'E') && /[-+0-9]/.test(src[i + 1] ?? '')) { i += 2; while (/[0-9]/.test(src[i] ?? '')) i++; }
      push('num', parseFloat(src.slice(start, i)), start); continue;
    }
    if (/[A-Za-z_$]/.test(c)) { while (i < n && /[\w$]/.test(src[i])) i++; push('id', src.slice(start, i), start); continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      const parts: (string | { src: string; line: number })[] = []; let cur = ''; let interp = false;
      while (i < n && src[i] !== q) {
        const ch = src[i];
        if (ch === '\\') {
          const e = src[i + 1]; i += 2;
          if (e === 'n') cur += '\n'; else if (e === 't') cur += '\t'; else if (e === 'r') cur += '\r';
          else if (e === 'u') { let h = ''; while (/[0-9a-fA-F]/.test(src[i] ?? '') && h.length < 4) h += src[i++]; cur += String.fromCharCode(parseInt(h, 16)); }
          else cur += e;
          continue;
        }
        if (ch === '\n') line++;
        if (q === "'" && ch === '$') {
          if (src[i + 1] === '$') { cur += '$'; i += 2; continue; }
          if (src[i + 1] === '{') {
            let d = 0, j = i + 1; const s0 = j + 1;
            do { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } while (j < n && d > 0);
            if (cur) parts.push(cur); cur = ''; parts.push({ src: src.slice(s0, j - 1), line }); interp = true; i = j; continue;
          }
          if (/[A-Za-z_]/.test(src[i + 1] ?? '')) {
            let j = i + 1; while (/[\w]/.test(src[j] ?? '')) j++;
            if (cur) parts.push(cur); cur = ''; parts.push({ src: src.slice(i + 1, j), line }); interp = true; i = j; continue;
          }
        }
        cur += ch; i++;
      }
      i++;
      if (interp) { if (cur) parts.push(cur); push('istr', parts, start); } else push('str', cur, start);
      continue;
    }
    let matched = false;
    for (const op of OPS) if (src.startsWith(op, i)) { push('op', op, start); i += op.length; matched = true; break; }
    if (matched) continue;
    push('op', c, start); i++;
  }
  push('eof', null, n);
  return toks;
}

// ============================================================================ parser
type Node = any;
const BINPREC: Record<string, number> = {
  '??': 1, '...': 2, '||': 3, '&&': 4,
  '==': 5, '!=': 5, '<': 5, '>': 5, '<=': 5, '>=': 5, 'is': 5,
  '|': 6, '&': 6, '^': 6, '<<': 7, '>>': 7, '>>>': 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
};
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);

class Parser {
  p = 0;
  constructor(private toks: Tok[]) { }
  private get cur() { return this.toks[this.p]; }
  private peek(k = 1) { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  private isOp(v: string) { const t = this.cur; return t.t === 'op' && t.v === v; }
  private isId(v: string) { const t = this.cur; return t.t === 'id' && t.v === v; }
  private eatOp(v: string) { if (this.isOp(v)) { this.p++; return true; } return false; }
  private eatId(v: string) { if (this.isId(v)) { this.p++; return true; } return false; }
  private expectOp(v: string) { if (!this.eatOp(v)) throw new HxError(`se esperaba "${v}" y se encontró "${this.cur.v ?? 'fin'}"`, this.cur.line); }
  private ident(): string { const t = this.cur; if (t.t !== 'id') throw new HxError(`se esperaba un identificador, se encontró "${t.v ?? 'fin'}"`, t.line); this.p++; return t.v; }

  parseProgram(): Node[] { const out: Node[] = []; while (this.cur.t !== 'eof') { const s = this.statement(); if (s) out.push(s); } return out; }

  /** ":Tipo<Args>" opcional */
  private skipType() {
    if (!this.eatOp(':')) return;
    this.typeExpr();
  }
  private typeExpr() {
    if (this.eatOp('(')) { // (A, B) -> C
      let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('(')) d++; else if (this.isOp(')')) d--; this.p++; }
      if (this.eatOp('->')) this.typeExpr(); return;
    }
    if (this.eatOp('{')) { let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('{')) d++; else if (this.isOp('}')) d--; this.p++; } return; }
    this.eatOp('?');
    this.ident(); while (this.eatOp('.')) this.ident();
    if (this.isOp('<')) { this.p++; let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } }
    if (this.eatOp('->')) this.typeExpr();
  }

  private block(): Node {
    this.expectOp('{'); const body: Node[] = [];
    while (!this.isOp('}')) { if (this.cur.t === 'eof') throw new HxError('falta "}"', this.cur.line); const s = this.statement(); if (s) body.push(s); }
    this.p++; return { k: 'block', body };
  }

  statement(): Node | null {
    const t = this.cur, line = t.line;
    if (t.t === 'op') {
      if (t.v === ';') { this.p++; return null; }
      if (t.v === '{') return this.block();
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'import': case 'using': case 'package': { while (!this.isOp(';') && this.cur.t !== 'eof') this.p++; this.p++; return null; }
        case 'var': case 'final': {
          if (t.v === 'final' && this.peek().t === 'id' && this.peek().v === 'function') break;
          this.p++; const decls: { name: string; init: Node | null }[] = [];
          do { const name = this.ident(); this.skipType(); let init: Node | null = null; if (this.eatOp('=')) init = this.expr(); decls.push({ name, init }); } while (this.eatOp(','));
          this.eatOp(';'); return { k: 'var', decls, line };
        }
        case 'public': case 'private': case 'static': case 'inline': case 'override': case 'extern': case 'dynamic': { this.p++; return this.statement(); }
        case 'function': if (this.peek().t === 'id') { this.p++; const name = this.ident(); const fn = this.funcRest(name); return { k: 'fundecl', name, fn, line }; } break;
        case 'if': {
          this.p++; this.expectOp('('); const c = this.expr(); this.expectOp(')');
          const a = this.statement() ?? { k: 'block', body: [] }; let b: Node | null = null;
          if (this.eatId('else')) b = this.statement() ?? { k: 'block', body: [] };
          return { k: 'if', c, a, b, line };
        }
        case 'while': { this.p++; this.expectOp('('); const c = this.expr(); this.expectOp(')'); const body = this.statement() ?? { k: 'block', body: [] }; return { k: 'while', c, body, line }; }
        case 'do': { this.p++; const body = this.statement() ?? { k: 'block', body: [] }; if (!this.eatId('while')) throw new HxError('se esperaba while', this.cur.line); this.expectOp('('); const c = this.expr(); this.expectOp(')'); this.eatOp(';'); return { k: 'dowhile', c, body, line }; }
        case 'for': {
          this.p++; this.expectOp('('); const v = this.ident(); let v2: string | null = null;
          if (this.eatOp('=>')) v2 = this.ident();
          if (!this.eatId('in')) throw new HxError('se esperaba "in"', this.cur.line);
          const it = this.expr(); this.expectOp(')'); const body = this.statement() ?? { k: 'block', body: [] };
          return { k: 'for', v, v2, it, body, line };
        }
        case 'return': { this.p++; let v: Node | null = null; if (!this.isOp(';') && !this.isOp('}')) v = this.expr(); this.eatOp(';'); return { k: 'return', v, line }; }
        case 'break': this.p++; this.eatOp(';'); return { k: 'break' };
        case 'continue': this.p++; this.eatOp(';'); return { k: 'continue' };
        case 'throw': { this.p++; const v = this.expr(); this.eatOp(';'); return { k: 'throw', v, line }; }
        case 'try': {
          this.p++; const body = this.statement()!; const catches: { name: string; body: Node }[] = [];
          while (this.eatId('catch')) { this.expectOp('('); const name = this.ident(); this.skipType(); this.expectOp(')'); catches.push({ name, body: this.statement()! }); }
          return { k: 'try', body, catches, line };
        }
        case 'switch': return this.switchStmt();
        case 'class': return this.classDecl();
        case 'enum': return this.enumDecl();
        case 'typedef': case 'interface': case 'abstract': this.skipDecl(); return null;
      }
    }
    const e = this.expr(); this.eatOp(';');
    return { k: 'expr', e, line };
  }

  private switchStmt(): Node {
    const line = this.cur.line; this.p++;
    const hasParen = this.eatOp('('); const subject = this.expr(); if (hasParen) this.expectOp(')');
    this.expectOp('{');
    const flat = (n: Node): Node[] => n.k === 'bin' && n.op === '|' ? [...flat(n.l), ...flat(n.r)] : [n];
    const cases: { pats: Node[] | null; guard: Node | null; body: Node[] }[] = [];
    while (!this.isOp('}')) {
      let pats: Node[] | null = null, guard: Node | null = null;
      if (this.eatId('default')) { this.expectOp(':'); }
      else if (this.eatId('case')) {
        pats = [];
        do { pats.push(...flat(this.expr())); } while (this.eatOp(','));
        if (this.eatId('if')) { const paren = this.eatOp('('); guard = this.expr(); if (paren) this.expectOp(')'); }
        this.expectOp(':');
      }
      else throw new HxError('se esperaba case/default', this.cur.line);
      const body: Node[] = [];
      while (!this.isOp('}') && !this.isId('case') && !this.isId('default')) { const st = this.statement(); if (st) body.push(st); }
      cases.push({ pats, guard, body });
    }
    this.p++; return { k: 'switch', subject, cases, line };
  }

  /** salta un typedef/interface/abstract completo */
  private skipDecl() {
    this.p++;
    while (this.cur.t !== 'eof' && !this.isOp('{') && !this.isOp(';')) this.p++;
    if (this.eatOp(';')) return;
    let d = 0;
    do { if (this.isOp('{')) d++; else if (this.isOp('}')) d--; this.p++; } while (d > 0 && this.cur.t !== 'eof');
    this.eatOp(';');
  }
  private skipBalanced(open: string, close: string) {
    if (!this.isOp(open)) return; let d = 0;
    do { if (this.isOp(open)) d++; else if (this.isOp(close)) d--; this.p++; } while (d > 0 && this.cur.t !== 'eof');
  }
  private dotted(): string { let n = this.ident(); while (this.eatOp('.')) n += '.' + this.ident(); if (this.isOp('<')) { this.p++; let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } } return n; }

  private enumDecl(): Node {
    const line = this.cur.line; this.p++;
    if (this.eatId('abstract')) {
      const name = this.ident(); this.skipBalanced('(', ')');
      while (this.cur.t === 'id' && (this.cur.v === 'from' || this.cur.v === 'to')) { this.p++; this.typeExpr(); }
      this.expectOp('{'); const vals: [string, Node | null][] = [];
      while (!this.isOp('}') && this.cur.t !== 'eof') {
        while (this.cur.t === 'id' && ['public', 'inline', 'static', 'final'].includes(this.cur.v)) this.p++;
        if (this.eatId('var')) { const vn = this.ident(); this.skipType(); let init: Node | null = null; if (this.eatOp('=')) init = this.expr(); this.eatOp(';'); vals.push([vn, init]); }
        else if (this.isId('function')) { this.p++; this.ident(); this.funcRest(null); }
        else this.p++;
      }
      this.p++; return { k: 'enumabs', name, vals, line };
    }
    const name = this.ident(); if (this.isOp('<')) { this.p++; let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } }
    this.expectOp('{'); const ctors: { name: string; params: string[] }[] = [];
    while (!this.isOp('}') && this.cur.t !== 'eof') {
      const cn = this.ident(); const params: string[] = [];
      if (this.eatOp('(')) { while (!this.isOp(')')) { this.eatOp('?'); params.push(this.ident()); this.skipType(); if (!this.eatOp(',')) break; } this.expectOp(')'); }
      this.skipType(); this.eatOp(';'); ctors.push({ name: cn, params });
    }
    this.p++; return { k: 'enumdecl', name, ctors, line };
  }

  private classDecl(): Node {
    const line = this.cur.line; this.p++;
    const name = this.ident(); if (this.isOp('<')) { this.p++; let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } }
    let parent: string | null = null;
    while (this.cur.t === 'id' && (this.cur.v === 'extends' || this.cur.v === 'implements')) { const kw = this.cur.v; this.p++; const t = this.dotted(); if (kw === 'extends') parent = t; }
    this.expectOp('{');
    const members: { kind: 'var' | 'fn'; name: string; isStatic: boolean; init?: Node | null; fn?: Node; acc?: string[] }[] = [];
    while (!this.isOp('}') && this.cur.t !== 'eof') {
      let isStatic = false;
      while (this.cur.t === 'id' && (['public', 'private', 'static', 'inline', 'override', 'dynamic', 'extern'].includes(this.cur.v) || (this.cur.v === 'final' && this.peek().t === 'id' && this.peek().v === 'function'))) {
        if (this.cur.v === 'static') isStatic = true; this.p++;
      }
      if (this.eatId('var') || this.eatId('final')) {
        const vn = this.ident(); let acc: string[] | undefined;
        if (this.eatOp('(')) { acc = []; while (!this.isOp(')')) { acc.push(String(this.cur.v)); this.p++; this.eatOp(','); } this.expectOp(')'); }
        this.skipType(); let init: Node | null = null; if (this.eatOp('=')) init = this.expr(); this.eatOp(';');
        members.push({ kind: 'var', name: vn, isStatic, init, acc });
      } else if (this.eatId('function')) {
        const fname = this.cur.t === 'id' ? this.ident() : 'new'; const fn = this.funcRest(fname);
        members.push({ kind: 'fn', name: fname, isStatic, fn });
      } else this.p++;
    }
    this.p++; return { k: 'classdecl', name, parent, members, line };
  }

  private funcRest(name: string | null): Node {
    if (this.isOp('<')) { this.p++; let d = 1; while (d > 0) { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } }
    this.expectOp('(');
    const params: { name: string; def: Node | null; rest?: boolean }[] = [];
    while (!this.isOp(')')) {
      this.eatOp('?'); const rest = this.eatOp('...');
      const pn = this.ident(); this.skipType(); let def: Node | null = null; if (this.eatOp('=')) def = this.expr();
      params.push({ name: pn, def, rest }); if (!this.eatOp(',')) break;
    }
    this.expectOp(')'); this.skipType();
    const body = this.isOp('{') ? this.block() : (this.cur.t === 'id' && ['return', 'if', 'for', 'while', 'switch', 'try', 'var', 'do'].includes(this.cur.v as string) ? (this.statement() as Node) : (() => { const e = this.expr(); this.eatOp(';'); return { k: 'return', v: e }; })());
    return { k: 'func', name, params, body };
  }

  // ---- expresiones
  expr(): Node { return this.assign(); }

  private assign(): Node {
    const lhs = this.ternary();
    const t = this.cur;
    if (t.t === 'op') {
      let op = t.v as string;
      // ">>=" / ">>>=" llegan como ">" ">" "="
      if (op === '>' && this.peek().t === 'op' && this.peek().v === '>' && this.peek().pos === t.pos + 1) {
        if (this.peek(2).t === 'op' && this.peek(2).v === '=' && this.peek(2).pos === t.pos + 2) { this.p += 3; const r = this.assign(); return { k: 'assign', op: '>>=', l: lhs, r, line: t.line }; }
      }
      if (ASSIGN.has(op)) { this.p++; const r = this.assign(); return { k: 'assign', op, l: lhs, r, line: t.line }; }
    }
    return lhs;
  }

  private ternary(): Node {
    const c = this.binary(1);
    if (this.isOp('?')) { this.p++; const a = this.assign(); this.expectOp(':'); const b = this.assign(); return { k: 'cond', c, a, b }; }
    return c;
  }

  private binOp(): { op: string; len: number } | null {
    const t = this.cur;
    if (t.t === 'id' && t.v === 'is') return { op: 'is', len: 1 };
    if (t.t !== 'op') return null;
    if (t.v === '>') { // combinar >> y >>>
      const a = this.peek(), b = this.peek(2);
      if (a.t === 'op' && a.v === '>' && a.pos === t.pos + 1) {
        if (b.t === 'op' && b.v === '>' && b.pos === t.pos + 2) return { op: '>>>', len: 3 };
        if (b.t === 'op' && b.v === '=' && b.pos === t.pos + 2) return null; // >>=
        return { op: '>>', len: 2 };
      }
      return { op: '>', len: 1 };
    }
    if (t.v in BINPREC) return { op: t.v, len: 1 };
    return null;
  }

  private binary(minPrec: number): Node {
    let left = this.unary();
    for (; ;) {
      const b = this.binOp(); if (!b) break;
      const prec = BINPREC[b.op]; if (prec < minPrec) break;
      const line = this.cur.line;
      this.p += b.len;
      let right: Node;
      if (b.op === 'is') { right = this.unary(); } else right = this.binary(prec + 1);
      left = b.op === '&&' || b.op === '||' || b.op === '??' ? { k: 'logic', op: b.op, l: left, r: right } : { k: 'bin', op: b.op, l: left, r: right, line };
    }
    return left;
  }

  private unary(): Node {
    const t = this.cur;
    if (t.t === 'op') {
      if (t.v === '-' || t.v === '!' || t.v === '~' || t.v === '+') { this.p++; const e = this.unary(); return { k: 'un', op: t.v, e }; }
      if (t.v === '++' || t.v === '--') { this.p++; const e = this.unary(); return { k: 'pre', op: t.v, e }; }
    }
    if (t.t === 'id' && (t.v === 'cast' || t.v === 'untyped')) {
      this.p++;
      if (t.v === 'cast' && this.isOp('(')) { this.p++; const e = this.expr(); if (this.eatOp(',')) this.typeExpr(); this.expectOp(')'); return e; }
      return this.unary();
    }
    return this.postfix(this.primary());
  }

  private args(): Node[] { const a: Node[] = []; while (!this.isOp(')')) { a.push(this.expr()); if (!this.eatOp(',')) break; } this.expectOp(')'); return a; }

  private postfix(e: Node): Node {
    for (; ;) {
      const t = this.cur, line = t.line;
      if (t.t !== 'op') break;
      if (t.v === '.' || t.v === '?.') { this.p++; const name = this.ident(); e = { k: 'field', o: e, name, safe: t.v === '?.', line }; }
      else if (t.v === '(') { this.p++; e = { k: 'call', f: e, args: this.args(), line }; }
      else if (t.v === '[') { this.p++; const i = this.expr(); this.expectOp(']'); e = { k: 'index', o: e, i, line }; }
      else if (t.v === '++' || t.v === '--') { this.p++; e = { k: 'post', op: t.v, e }; }
      else break;
    }
    return e;
  }

  private isLambdaAhead(): boolean { // "(" ... ")" "->"
    let d = 0, j = this.p;
    for (; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === 'op' && t.v === '(') d++;
      else if (t.t === 'op' && t.v === ')') { d--; if (d === 0) break; }
      else if (t.t === 'eof') return false;
    }
    const n = this.toks[j + 1]; return !!n && n.t === 'op' && n.v === '->';
  }

  private primary(): Node {
    const t = this.cur, line = t.line;
    switch (t.t) {
      case 'num': this.p++; return { k: 'lit', v: t.v };
      case 'str': this.p++; return { k: 'lit', v: t.v };
      case 'regex': this.p++; return { k: 'regex', src: t.v, flags: t.flags ?? '' };
      case 'istr': {
        this.p++;
        const parts = (t.v as (string | { src: string; line: number })[]).map(p => typeof p === 'string' ? p : new Parser(lex(p.src)).expr());
        return { k: 'interp', parts };
      }
      case 'id': {
        switch (t.v) {
          case 'true': this.p++; return { k: 'lit', v: true };
          case 'false': this.p++; return { k: 'lit', v: false };
          case 'null': this.p++; return { k: 'lit', v: null };
          case 'this': this.p++; return { k: 'id', name: 'this', line };
          case 'switch': return this.switchStmt();
          case 'function': { this.p++; const name = this.cur.t === 'id' ? this.ident() : null; return this.funcRest(name); }
          case 'new': {
            this.p++; let cls = this.ident(); while (this.eatOp('.')) cls += '.' + this.ident();
            if (this.isOp('<')) { this.p++; let d = 1; while (d > 0 && this.cur.t !== 'eof') { if (this.isOp('<')) d++; else if (this.isOp('>')) d--; this.p++; } }
            this.expectOp('('); return { k: 'new', cls, args: this.args(), line };
          }
          default:
            this.p++;
            if (this.isOp('->') ) { this.p++; const body = this.lambdaBody(); return { k: 'func', name: null, params: [{ name: t.v, def: null }], body }; }
            return { k: 'id', name: t.v, line };
        }
      }
      case 'op': {
        if (t.v === '(') {
          if (this.isLambdaAhead()) {
            this.p++; const params: { name: string; def: Node | null }[] = [];
            while (!this.isOp(')')) { const n = this.ident(); this.skipType(); params.push({ name: n, def: null }); if (!this.eatOp(',')) break; }
            this.expectOp(')'); this.expectOp('->'); return { k: 'func', name: null, params, body: this.lambdaBody() };
          }
          this.p++; const e = this.expr(); if (this.isOp(':')) { this.p++; this.typeExpr(); } this.expectOp(')'); return { k: 'paren', e };
        }
        if (t.v === '[') return this.arrayLit();
        if (t.v === '{') return this.objectLit();
        break;
      }
    }
    throw new HxError(`expresión inesperada "${t.v ?? 'fin del archivo'}"`, line);
  }
  private lambdaBody(): Node { if (this.isOp('{')) return this.block(); return { k: 'return', v: this.expr() }; }

  private arrayLit(): Node {
    this.expectOp('[');
    if (this.isId('for') || this.isId('while')) { const comp = this.comprehension(); this.expectOp(']'); return comp; }
    const items: Node[] = []; let isMap = false; const pairs: [Node, Node][] = [];
    while (!this.isOp(']')) {
      const e = this.expr();
      if (this.eatOp('=>')) { isMap = true; pairs.push([e, this.expr()]); } else items.push(e);
      if (!this.eatOp(',')) break;
    }
    this.expectOp(']');
    return isMap ? { k: 'maplit', pairs } : { k: 'arr', items };
  }
  private comprehension(): Node {
    const line = this.cur.line;
    if (this.eatId('for')) {
      this.expectOp('('); const v = this.ident(); let v2: string | null = null; if (this.eatOp('=>')) v2 = this.ident();
      this.eatId('in'); const it = this.expr(); this.expectOp(')');
      const body = (this.isId('for') || this.isId('if')) ? this.comprehension() : this.expr();
      return { k: 'comp', v, v2, it, body, line };
    }
    if (this.eatId('if')) { this.expectOp('('); const c = this.expr(); this.expectOp(')'); const body = this.isId('for') ? this.comprehension() : this.expr(); return { k: 'compif', c, body }; }
    throw new HxError('comprensión no válida', line);
  }
  private objectLit(): Node {
    this.expectOp('{'); const fields: [string, Node][] = [];
    while (!this.isOp('}')) {
      const t = this.cur; let key: string;
      if (t.t === 'id' || t.t === 'str') { key = String(t.v); this.p++; } else throw new HxError('clave de objeto no válida', t.line);
      this.expectOp(':'); fields.push([key, this.expr()]);
      if (!this.eatOp(',')) break;
    }
    this.expectOp('}'); return { k: 'obj', fields };
  }
}

export function parseHx(src: string): Node[] {
  return new Parser(lex(preprocess(src))).parseProgram();
}

// ============================================================================ entorno
export class Env {
  vars = new Map<string, any>();
  constructor(public parent: Env | null = null) { }
  has(n: string): boolean { return this.vars.has(n) || (this.parent ? this.parent.has(n) : false); }
  get(n: string): any { const e = this.find(n); return e ? e.vars.get(n) : undefined; }
  find(n: string): Env | null { let e: Env | null = this; while (e) { if (e.vars.has(n)) return e; e = e.parent; } return null; }
  set(n: string, v: any): boolean { const e = this.find(n); if (e) { e.vars.set(n, v); return true; } return false; }
  def(n: string, v: any) { this.vars.set(n, v); }
}

/** Entorno cuyas variables son los campos de un objeto (métodos de clases de Haxe). */
export class ObjEnv extends Env {
  constructor(parent: Env | null, public obj: any) {
    super(parent);
    const o = obj;
    (this as any).vars = { has: (n: string) => n in o, get: (n: string) => o[n], set: (n: string, v: any) => { o[n] = v; return true; } };
  }
}

export class HxReg {
  r: RegExp; private m: RegExpExecArray | null = null; private src = '';
  constructor(pat: string, flags = '') { this.r = new RegExp(pat, flags.replace(/[^gimsuy]/g, '')); }
  match(s: string) { this.src = s; this.r.lastIndex = 0; this.m = this.r.exec(s); return this.m !== null; }
  matched(i = 0) { return this.m ? (this.m[i] ?? null) : null; }
  matchedLeft() { return this.m ? this.src.slice(0, this.m.index) : null; }
  matchedRight() { return this.m ? this.src.slice(this.m.index + this.m[0].length) : null; }
  replace(s: string, by: string) { return s.replace(new RegExp(this.r.source, this.r.flags.replace('g', '')), by); }
  split(s: string) { return s.split(new RegExp(this.r.source, this.r.flags)); }
}

/** Mapa de Haxe (Map<K,V>) */
export class HxMap {
  m = new Map<any, any>();
  set(k: any, v: any) { this.m.set(k, v); return v; }
  get(k: any) { return this.m.has(k) ? this.m.get(k) : null; }
  exists(k: any) { return this.m.has(k); }
  remove(k: any) { return this.m.delete(k); }
  keys() { return makeIter([...this.m.keys()]); }
  iterator() { return makeIter([...this.m.values()]); }
  keyValueIterator() { return makeIter([...this.m.entries()].map(([key, value]) => ({ key, value }))); }
  clear() { this.m.clear(); }
  copy() { const c = new HxMap(); c.m = new Map(this.m); return c; }
  get length() { return this.m.size; }
  toString() { return '{' + [...this.m].map(([k, v]) => `${k} => ${v}`).join(', ') + '}'; }
  [Symbol.iterator]() { return this.m.values(); }
}
export function makeIter(arr: any[]) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++], [Symbol.iterator]: () => arr[Symbol.iterator]() }; }

// ============================================================================ evaluador
export interface HxHooks {
  /** variables/funciones globales que no son locales del script (clases, PlayState, etc.) */
  lookup(name: string): { found: boolean; value?: any };
  /** asignación a un identificador desconocido: ¿lo acepta el padre? */
  assignGlobal(name: string, value: any): boolean;
  /** conversión al asignar propiedades (camera -> nombre, etc.) */
  setField(obj: any, name: string, value: any): boolean;
  /** método que no existe en el objeto (set de puntos, etc.) */
  missingMethod(obj: any, name: string, args: any[]): { handled: boolean; value?: any };
  construct(cls: string, args: any[]): { found: boolean; value?: any };
}

const ARRAY_EXT: Record<string, (a: any[], ...x: any[]) => any> = {
  insert: (a, i, v) => { a.splice(i, 0, v); },
  remove: (a, v) => { const i = a.indexOf(v); if (i >= 0) { a.splice(i, 1); return true; } return false; },
  contains: (a, v) => a.includes(v),
  copy: a => a.slice(),
  iterator: a => makeIter(a),
  resize: (a, n) => { a.length = n; },
  indexOf: (a, v, from = 0) => a.indexOf(v, from),
  lastIndexOf: (a, v) => a.lastIndexOf(v),
  sort: (a, f) => { a.sort(f); },
  push: (a, v) => a.push(v),
  join: (a, s = ',') => a.join(s),
  toString: a => '[' + a.join(',') + ']',
};
const STRING_EXT: Record<string, (s: string, ...x: any[]) => any> = {
  charAt: (s, i) => s.charAt(i), charCodeAt: (s, i) => { const c = s.charCodeAt(i); return isNaN(c) ? null : c; },
  substr: (s, p, l) => (l === undefined || l === null ? s.substr(p) : s.substr(p, l)),
  substring: (s, a, b) => s.substring(a, b === null ? undefined : b),
  indexOf: (s, x, f = 0) => s.indexOf(x, f), lastIndexOf: (s, x) => s.lastIndexOf(x),
  split: (s, d) => s.split(d), toUpperCase: s => s.toUpperCase(), toLowerCase: s => s.toLowerCase(), toString: s => s,
};

export class Interp {
  globals = new Env();
  constructor(public hooks: HxHooks, public file = 'script') { }

  run(prog: Node[], env: Env = this.globals): any {
    // las funciones se elevan (hoisting) para poder llamarse antes de su declaración
    for (const s of prog) if (s.k === 'fundecl') env.def(s.name, this.makeFunc(s.fn, env));
    for (const s of prog) if (s.k === 'enumdecl' || s.k === 'enumabs' || s.k === 'classdecl') this.exec(s, env);
    let last: any;
    try {
      for (const s of prog) { if (s.k === 'fundecl' || s.k === 'enumdecl' || s.k === 'enumabs' || s.k === 'classdecl') continue; last = this.exec(s, env); }
    } catch (e) { if (e instanceof Return) return e.v; throw e; }
    return last;
  }

  call(name: string, args: any[]): any {
    const f = this.globals.get(name);
    if (typeof f !== 'function') return undefined;
    return f(...args);
  }
  has(name: string) { return typeof this.globals.get(name) === 'function'; }

  private matchPat(p: Node, v: any, sc: Env): boolean {
    const isEnum = (x: any) => x !== null && typeof x === 'object' && x.__enum !== undefined;
    switch (p.k) {
      case 'id': {
        if (p.name === '_') return true;
        if (/^[A-Z]/.test(p.name)) {
          if (isEnum(v) && v.name === p.name) return true;
          const o = this.getVarOpt(p.name, sc); return o !== undefined && o === v;
        }
        sc.def(p.name, v); return true;
      }
      case 'call': {
        const f = p.f; const cname = f.k === 'id' ? f.name : f.k === 'field' ? f.name : null;
        if (!cname || !isEnum(v) || v.name !== cname) return false;
        return p.args.every((a: Node, i: number) => this.matchPat(a, v.params[i], sc));
      }
      case 'arr': return Array.isArray(v) && v.length === p.items.length && p.items.every((it: Node, i: number) => this.matchPat(it, v[i], sc));
      case 'obj': return v !== null && typeof v === 'object' && p.fields.every(([k, vn]: [string, Node]) => this.matchPat(vn, v[k], sc));
      case 'field': { const e = this.ev(p, sc); return e === v || (isEnum(e) && isEnum(v) && e.__enum === v.__enum && e.name === v.name && e.params.length === 0); }
    }
    const e = this.ev(p, sc); return e === v || (e == null && v == null);
  }

  private makeClass(n: Node, env: Env): any {
    const parentName = n.parent ? String(n.parent).split('.').pop()! : null;
    const parentCls = parentName ? this.getVarOpt(parentName, env) : null;
    const cls: any = { __hxclass: true, __name: n.name, __parent: parentCls && parentCls.__hxclass ? parentCls : null };
    const senv = new ObjEnv(env, cls); cls.__senv = senv; cls.__members = n.members;
    for (const m of n.members) if (m.isStatic && m.kind === 'fn') cls[m.name] = this.makeFunc(m.fn, senv);
    for (const m of n.members) if (m.isStatic && m.kind === 'var') cls[m.name] = m.init ? this.ev(m.init, senv) : null;
    cls.__new = (args: any[]) => {
      const obj: any = {}; const classes: any[] = []; const layers: any[] = [];
      const build = (c: any): any => {
        const parentLayer = c.__parent ? build(c.__parent) : {};
        classes.push(c);
        const ienv = new ObjEnv(c.__senv, obj);
        const lenv = new Env(ienv); lenv.def('this', obj); lenv.def('super', parentLayer);
        const layer: any = {};
        for (const m of c.__members) if (!m.isStatic && m.kind === 'fn') layer[m.name] = this.makeFunc(m.fn, lenv);
        for (const k of Object.keys(layer)) if (k !== 'new') obj[k] = layer[k];
        for (const m of c.__members) if (!m.isStatic && m.kind === 'var') {
          if (m.acc && (m.acc[0] === 'get' || m.acc[1] === 'set')) {
            const g = layer['get_' + m.name], st = layer['set_' + m.name];
            Object.defineProperty(obj, m.name, { configurable: true, enumerable: true, get: m.acc[0] === 'get' && g ? () => g() : () => null, set: m.acc[1] === 'set' && st ? (v: any) => { st(v); } : () => { } });
          } else obj[m.name] = m.init ? this.ev(m.init, lenv) : null;
        }
        layers.push(layer);
        return layer;
      };
      build(cls);
      obj.__classes = classes;
      for (let i = layers.length - 1; i >= 0; i--) if (layers[i].new) { layers[i].new(...args); break; }
      return obj;
    };
    return cls;
  }

  private makeFunc(fn: Node, env: Env): (...a: any[]) => any {
    const self = this;
    const f = function (...args: any[]) {
      const local = new Env(env);
      for (let i = 0; i < fn.params.length; i++) {
        const p = fn.params[i];
        if (p.rest) { local.def(p.name, args.slice(i)); break; }
        let v = args[i];
        if ((v === undefined || v === null) && p.def) v = self.ev(p.def, local);
        local.def(p.name, v === undefined ? null : v);
      }
      try { const r = self.exec(fn.body, local); return fn.body.k === 'return' ? r : null; }
      catch (e) { if (e instanceof Return) return e.v; throw e; }
    };
    return f;
  }

  exec(n: Node, env: Env): any {
    switch (n.k) {
      case 'expr': return this.ev(n.e, env);
      case 'block': { const local = new Env(env); for (const s of n.body) { if (s.k === 'fundecl') local.def(s.name, this.makeFunc(s.fn, local)); } for (const s of n.body) { if (s.k !== 'fundecl') this.exec(s, local); } return undefined; }
      case 'var': for (const d of n.decls) env.def(d.name, d.init ? this.ev(d.init, env) : null); return undefined;
      case 'fundecl': env.def(n.name, this.makeFunc(n.fn, env)); return undefined;
      case 'if': if (truthy(this.ev(n.c, env))) return this.exec(n.a, env); else if (n.b) return this.exec(n.b, env); return undefined;
      case 'while': {
        let guard = 0;
        while (truthy(this.ev(n.c, env))) {
          if (++guard > 5_000_000) throw new HxError('bucle while demasiado largo', n.line);
          try { this.exec(n.body, env); } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e; }
        }
        return undefined;
      }
      case 'dowhile': {
        do { try { this.exec(n.body, env); } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e; } } while (truthy(this.ev(n.c, env)));
        return undefined;
      }
      case 'for': {
        const it = this.ev(n.it, env);
        for (const item of this.iterate(it, n.v2 != null)) {
          const local = new Env(env);
          if (n.v2 != null) { local.def(n.v, item.key); local.def(n.v2, item.value); } else local.def(n.v, item);
          try { this.exec(n.body, local); } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e; }
        }
        return undefined;
      }
      case 'return': throw new Return(n.v ? this.ev(n.v, env) : null);
      case 'break': throw new Break();
      case 'continue': throw new Continue();
      case 'throw': throw new Thrown(this.ev(n.v, env));
      case 'try': {
        try { return this.exec(n.body, env); }
        catch (e) {
          if (e instanceof Return || e instanceof Break || e instanceof Continue) throw e;
          const c = n.catches[0]; if (!c) throw e;
          const local = new Env(env); local.def(c.name, e instanceof Thrown ? e.v : (e as Error)?.message ?? String(e));
          return this.exec(c.body, local);
        }
      }
      case 'enumdecl': {
        const E: any = { __enumType: n.name };
        for (const c of n.ctors) {
          if (c.params.length === 0) E[c.name] = { __enum: n.name, name: c.name, params: [] };
          else E[c.name] = (...a: any[]) => ({ __enum: n.name, name: c.name, params: a });
        }
        E.createAll = () => n.ctors.filter((c: any) => !c.params.length).map((c: any) => E[c.name]);
        env.def(n.name, E);
        // Haxe infiere el enum por tipo esperado: permite usar el constructor sin prefijo
        for (const c of n.ctors) if (!env.has(c.name)) env.def(c.name, E[c.name]);
        return undefined;
      }
      case 'enumabs': {
        const E: any = {}; let auto = 0;
        for (const [name, init] of n.vals) { const v = init ? this.ev(init, env) : auto; E[name] = v; if (typeof v === 'number') auto = v + 1; }
        env.def(n.name, E); return undefined;
      }
      case 'classdecl': env.def(n.name, this.makeClass(n, env)); return undefined;
      case 'switch': {
        const v = this.ev(n.subject, env);
        let def: any = null, hit: any = null, scope: Env | null = null;
        for (const c of n.cases) {
          if (c.pats === null) { def = c; continue; }
          for (const p of c.pats) {
            const sc = new Env(env);
            if (this.matchPat(p, v, sc) && (!c.guard || truthy(this.ev(c.guard, sc)))) { hit = c; scope = sc; break; }
          }
          if (hit) break;
        }
        if (!hit) { hit = def; scope = new Env(env); }
        if (!hit) return undefined;
        // un case vacío cae al siguiente (case 1: case 2: ...)
        let idx = n.cases.indexOf(hit);
        while (idx < n.cases.length - 1 && n.cases[idx].body.length === 0) idx++;
        let last: any;
        try { for (const st of n.cases[idx].body) last = this.exec(st, scope!); } catch (e) { if (e instanceof Break) return undefined; throw e; }
        return last;
      }
      case 'return_': return undefined;
    }
    return this.ev(n, env);
  }

  private *iterate(it: any, kv: boolean): Generator<any> {
    if (it == null) throw new HxError('no se puede iterar null');
    if (it.k === 'range') { /* no ocurre */ }
    if (it && it.__range) { for (let i = it.from; i < it.to; i++) yield i; return; }
    if (it instanceof HxMap) { if (kv) { for (const [key, value] of it.m) yield { key, value }; } else yield* it.m.values(); return; }
    if (Array.isArray(it)) { if (kv) { let i = 0; for (const v of it) yield { key: i++, value: v }; } else yield* it; return; }
    if (typeof it.hasNext === 'function' && typeof it.next === 'function') { while (it.hasNext()) yield it.next(); return; }
    if (typeof it.iterator === 'function') { yield* this.iterate(it.iterator(), kv); return; }
    if (it.members && Array.isArray(it.members)) { yield* it.members; return; }
    if (it.items && Array.isArray(it.items)) { yield* it.items; return; }
    if (typeof it[Symbol.iterator] === 'function') { yield* it; return; }
    if (typeof it === 'object') { for (const k of Object.keys(it)) yield kv ? { key: k, value: it[k] } : k; return; }
    throw new HxError('valor no iterable');
  }

  // ---------------------------------------------------------------- expresiones
  ev(n: Node, env: Env): any {
    switch (n.k) {
      case 'lit': return n.v;
      case 'regex': return new HxReg(n.src, n.flags);
      case 'switch': return this.exec(n, env);
      case 'paren': return this.ev(n.e, env);
      case 'interp': return n.parts.map((p: any) => typeof p === 'string' ? p : str(this.ev(p, env))).join('');
      case 'id': return this.getVar(n.name, env, n.line);
      case 'arr': return n.items.map((i: Node) => this.ev(i, env));
      case 'maplit': { const m = new HxMap(); for (const [k, v] of n.pairs) m.set(this.ev(k, env), this.ev(v, env)); return m; }
      case 'obj': { const o: any = {}; for (const [k, v] of n.fields) o[k] = this.ev(v, env); return o; }
      case 'comp': { const out: any[] = []; this.compRun(n, env, out); return out; }
      case 'func': {
        const f = this.makeFunc(n, env);
        if (n.name) env.def(n.name, f);
        return f;
      }
      case 'cond': return truthy(this.ev(n.c, env)) ? this.ev(n.a, env) : this.ev(n.b, env);
      case 'logic': {
        const l = this.ev(n.l, env);
        if (n.op === '&&') return truthy(l) ? this.ev(n.r, env) : l;
        if (n.op === '||') return truthy(l) ? l : this.ev(n.r, env);
        return l !== null && l !== undefined ? l : this.ev(n.r, env);
      }
      case 'un': {
        const v = this.ev(n.e, env);
        switch (n.op) { case '-': return -v; case '+': return +v; case '!': return !truthy(v); case '~': return ~v; }
        return undefined;
      }
      case 'pre': case 'post': {
        const old = this.ev(n.e, env); const nv = n.op === '++' ? old + 1 : old - 1;
        this.assignTo(n.e, nv, env); return n.k === 'pre' ? nv : old;
      }
      case 'bin': return this.binop(n.op, this.ev(n.l, env), this.ev(n.r, env), n);
      case 'assign': {
        if (n.op === '=') { const v = this.ev(n.r, env); this.assignTo(n.l, v, env); return v; }
        if (n.op === '??=') { const cur = this.ev(n.l, env); if (cur !== null && cur !== undefined) return cur; const v = this.ev(n.r, env); this.assignTo(n.l, v, env); return v; }
        const cur = this.ev(n.l, env); const r = this.ev(n.r, env);
        const v = this.binop(n.op.slice(0, -1), cur, r, n); this.assignTo(n.l, v, env); return v;
      }
      case 'field': {
        const o = this.ev(n.o, env);
        if (o === null || o === undefined) { if (n.safe) return null; throw new HxError(`no se puede leer "${n.name}" de null`, n.line); }
        return this.getField(o, n.name);
      }
      case 'index': {
        const o = this.ev(n.o, env), i = this.ev(n.i, env);
        if (o === null || o === undefined) throw new HxError('índice sobre null', n.line);
        if (o instanceof HxMap) return o.get(i);
        const v = o[i]; return v === undefined ? null : v;
      }
      case 'call': return this.callNode(n, env);
      case 'new': {
        const args = n.args.map((a: Node) => this.ev(a, env));
        if (n.cls === 'Array') return [];
        if (n.cls === 'Map' || n.cls.endsWith('Map')) return new HxMap();
        const r = this.hooks.construct(n.cls, args);
        if (r.found) return r.value;
        const cls = this.getVarOpt(n.cls, env);
        if (cls && cls.__hxclass) return cls.__new(args);
        if (typeof cls === 'function') { try { return new (cls as any)(...args); } catch { return (cls as any)(...args); } }
        throw new HxError(`clase desconocida: ${n.cls}`, n.line);
      }
      case 'bin_': return undefined;
    }
    throw new HxError('nodo no soportado: ' + n.k);
  }

  private compRun(n: Node, env: Env, out: any[]) {
    if (n.k === 'comp') {
      for (const item of this.iterate(this.ev(n.it, env), n.v2 != null)) {
        const local = new Env(env);
        if (n.v2 != null) { local.def(n.v, item.key); local.def(n.v2, item.value); } else local.def(n.v, item);
        if (n.body.k === 'comp' || n.body.k === 'compif') this.compRun(n.body, local, out); else out.push(this.ev(n.body, local));
      }
    } else if (n.k === 'compif') {
      if (truthy(this.ev(n.c, env))) { if (n.body.k === 'comp' || n.body.k === 'compif') this.compRun(n.body, env, out); else out.push(this.ev(n.body, env)); }
    }
  }

  private getVarOpt(name: string, env: Env): any {
    if (env.has(name)) return env.get(name);
    const h = this.hooks.lookup(name); return h.found ? h.value : undefined;
  }
  private getVar(name: string, env: Env, line: number): any {
    if (env.has(name)) return env.get(name);
    const h = this.hooks.lookup(name);
    if (h.found) return h.value;
    throw new HxError(`variable desconocida: ${name}`, line);
  }

  private getField(o: any, name: string): any {
    if (typeof o === 'string') {
      if (name === 'length') return o.length;
      const f = STRING_EXT[name]; if (f) return (...a: any[]) => f(o, ...a);
    } else if (Array.isArray(o)) {
      if (name === 'length') return o.length;
      const f = ARRAY_EXT[name]; if (f) return (...a: any[]) => f(o, ...a);
    }
    const v = o[name];
    if (typeof v === 'function' && !(v as any).__hx) return v.bind(o);
    return v === undefined ? null : v;
  }

  private assignTo(target: Node, v: any, env: Env) {
    switch (target.k) {
      case 'id': {
        if (env.set(target.name, v)) return;
        if (this.hooks.assignGlobal(target.name, v)) return;
        this.globals.def(target.name, v); return;
      }
      case 'paren': return this.assignTo(target.e, v, env);
      case 'field': {
        const o = this.ev(target.o, env);
        if (o === null || o === undefined) throw new HxError(`no se puede asignar "${target.name}" en null`, target.line);
        if (!this.hooks.setField(o, target.name, v)) o[target.name] = v;
        return;
      }
      case 'index': {
        const o = this.ev(target.o, env), i = this.ev(target.i, env);
        if (o instanceof HxMap) { o.set(i, v); return; }
        o[i] = v; return;
      }
    }
    throw new HxError('no se puede asignar a esta expresión');
  }

  private callNode(n: Node, env: Env): any {
    const args = n.args.map((a: Node) => this.ev(a, env));
    const f = n.f;
    if (f.k === 'field') {
      const o = this.ev(f.o, env);
      if (o === null || o === undefined) { if (f.safe) return null; throw new HxError(`no se puede llamar "${f.name}" sobre null`, n.line); }
      return this.callMethod(o, f.name, args, n.line);
    }
    if (f.k === 'id' && f.name === 'super') { const sp = this.getVarOpt('super', env); const c = sp && sp.new; if (typeof c === 'function') c(...args); return null; }
    const fn = this.ev(f, env);
    if (typeof fn !== 'function') throw new HxError(`"${f.name ?? 'expresión'}" no es una función`, n.line);
    return fn(...args);
  }

  callMethod(o: any, name: string, args: any[], line = 0): any {
    if (typeof o === 'string') { const sf = STRING_EXT[name]; if (sf) return sf(o, ...args); }
    else if (Array.isArray(o)) {
      const ex = ARRAY_EXT[name]; if (ex) return ex(o, ...args);
      if (name === 'map' || name === 'filter') return (o as any)[name]((x: any) => args[0](x));
    }
    const m = o[name];
    if (typeof m === 'function') { const r = m.apply(o, args); return r === undefined ? null : r; }
    const h = this.hooks.missingMethod(o, name, args);
    if (h.handled) return h.value === undefined ? null : h.value;
    throw new HxError(`el objeto no tiene el método "${name}"`, line);
  }

  private binop(op: string, a: any, b: any, n: Node): any {
    switch (op) {
      case '+': return (typeof a === 'string' || typeof b === 'string') ? str(a) + str(b) : a + b;
      case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
      case '==': return a === b || (a == null && b == null);
      case '!=': return !(a === b || (a == null && b == null));
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      case '...': return { __range: true, from: a, to: b, hasNext() { return false; }, next() { return null; } };
      case 'is': return b && b.__hxclass ? !!a && typeof a === 'object' && (a.__classes ?? []).includes(b) : typeof b === 'function' ? a instanceof b : false;
    }
    throw new HxError('operador no soportado: ' + op, n.line);
  }
}

export function truthy(v: any): boolean { return v !== false && v !== null && v !== undefined; }
export function str(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (Array.isArray(v)) return '[' + v.map(str).join(',') + ']';
  if (typeof v === 'object') { if (v.__enum) return v.params.length ? `${v.name}(${v.params.map(str).join(',')})` : v.name; if (typeof v.toString === 'function' && v.__classes) return String(v.toString()); if (v instanceof HxMap) return v.toString(); if (v.constructor === Object) return '{' + Object.entries(v).map(([k, x]) => `${k}: ${str(x)}`).join(', ') + '}'; }
  return String(v);
}
