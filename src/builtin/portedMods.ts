/** Catálogo de mods portados a India Engine (aparece en el menú "Mods"). */
export interface PortedMod {
  /** nombre de la carpeta del mod (mods/<id>) o id de la skin */
  id: string;
  name: string;
  desc: string;
  /** "mod" = contiene canciones; "skin" = se activa con un interruptor */
  kind: 'mod' | 'skin';
  tags: string[];
  /** autor original */
  author: string;
}

export const PORTED_MODS: PortedMod[] = [
  { id: 'Pico Mix', name: 'Pico Mix', kind: 'mod', author: 'Pico Mix (port a Psych)', tags: ['pico', 'nene', 'semana 1-7', 'erect', 'remix'],
    desc: 'Los Pico Mixes del juego base: Pico juega contra el elenco clásico, con cinemáticas, stages y personajes nuevos.' },
  { id: 'sserafim', name: 'Sserafim BF', kind: 'skin', author: 'Skin de BF (Le Sserafim)', tags: ['skin', 'boyfriend', 'bf'],
    desc: 'Skin de Boyfriend: BF, navidad, auto y oscuro. Se activa o desactiva con ENTER.' },
];
