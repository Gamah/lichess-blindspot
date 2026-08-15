// Just enough PGN to turn a lichess export into the shape the analysis code
// already reads. Not a general parser and not part of the app: the browser
// only ever sees ndjson, because that is what `Accept` asks for. This exists
// because a person downloading their own games from a browser gets PGN
// whether they wanted it or not, and that dump is the only way to get a real
// corpus of one player's history onto this host (see CLAUDE.md on why the
// by-user export is not called from here).
//
// **What PGN cannot carry.** The ndjson `analysis` array has `best` and
// `variation` per ply; the PGN has only `[%eval]`. So a game parsed here has
// evals and nothing else, and `findCandidates` cannot run against it unchanged
// — its `variation.length > 0` test is lila's "the engine disagreed" and there
// is no variation to test. Whatever uses this has to reconstruct that some
// other way and say so.
//
// `[%eval]` is in pawns from White's point of view, and `#n` is mate in n,
// negative when Black is mating — the same convention as the JSON `eval`/
// `mate` fields, so the conversion is only a factor of a hundred.

import type { AnalysisEntry } from '../src/analysis/candidates.ts';
import type { ExportedGame } from '../src/lichess/export.ts';

const HEADER = /^\[(\w+)\s+"([^"]*)"\]$/;

/** A SAN move, with or without the check/mate suffix and promotion. */
const TOKEN =
  /(O-O-O|O-O|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?)([+#]?)|\{\s*\[%eval\s+([^\]]+)\]/g;

const entryOf = (raw: string): AnalysisEntry => {
  const mate = raw.startsWith('#');
  if (mate) return { mate: Number(raw.slice(1)) };
  return { eval: Math.round(Number(raw) * 100) };
};

/**
 * One game per header block. Returns the same fields the export would, minus
 * everything PGN has no room for: no `division`, and the `analysis` entries
 * carry `eval`/`mate` only.
 */
export function parsePgn(text: string): ExportedGame[] {
  const games: ExportedGame[] = [];
  // A game is a run of header lines followed by its movetext. Splitting on the
  // header that always starts one is more robust than splitting on blank
  // lines, which lichess uses twice between games and once inside them.
  for (const chunk of text.split(/\n(?=\[Event )/)) {
    const tags: Record<string, string> = {};
    const lines = chunk.split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
      const m = HEADER.exec(lines[i]!.trim());
      if (!m) {
        if (lines[i]!.trim()) break;
        continue;
      }
      tags[m[1]!] = m[2]!;
    }
    const movetext = lines.slice(i).join(' ').trim();
    if (!movetext) continue;

    const moves: string[] = [];
    const analysis: AnalysisEntry[] = [];
    for (let m = TOKEN.exec(movetext); m; m = TOKEN.exec(movetext)) {
      if (m[1]) {
        moves.push(m[1] + (m[2] ?? ''));
        // Every move gets a slot so the array stays aligned with `moves`; a
        // move with no comment leaves a hole rather than shifting everything
        // after it. `findCandidates` already indexes defensively.
        analysis.push({});
      } else if (m[3] && analysis.length) {
        analysis[analysis.length - 1] = entryOf(m[3].trim());
      }
    }
    if (!moves.length) continue;

    const id = tags['GameId'] ?? tags['Site']?.split('/').pop() ?? '';
    const user = (name: string | undefined) =>
      name && name !== '?' ? { user: { id: name.toLowerCase(), name } } : {};
    games.push({
      id,
      rated: (tags['Event'] ?? '').includes('rated'),
      variant: (tags['Variant'] ?? 'Standard').toLowerCase() === 'standard' ? 'standard' : 'other',
      speed: '',
      perf: '',
      createdAt: 0,
      lastMoveAt: 0,
      status: '',
      players: { white: user(tags['White']), black: user(tags['Black']) },
      ...(tags['FEN'] ? { initialFen: tags['FEN'] } : {}),
      moves: moves.join(' '),
      analysis,
    });
  }
  return games;
}
