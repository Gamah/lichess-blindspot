import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findCandidates } from '../src/analysis/candidates.ts';
import { replay } from '../src/deck/positions.ts';
import { analyseGame, type Analyser } from '../src/engine/analyse.ts';
import type { EngineLine, Request } from '../src/engine/protocol.ts';

// White hangs a knight on move 5 (index 4). The fake engine scores by position
// rather than by ply, because that is what a real one does: pass 2 asks about
// the same FEN pass 1 already asked about and must get the same answer.
const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5', 'Nf6', 'Nxf7', 'Kxf7'];
const steps = replay(MOVES);

/** cp, white POV, keyed by the position each move led to. */
const AFTER = [20, 15, 25, 20, -900, -880, -870, -890];

// Answers are keyed by position, not by ply: `before` and `after` positions
// overlap (the position before move i is the position after move i-1), so a
// fake that keyed on the request would answer the same FEN two ways.
class Fake implements Analyser {
  seen: Request[] = [];
  analyse(req: Request): Promise<EngineLine> {
    this.seen.push(req);
    const index = steps.findIndex(s => s.after === req.fen);
    assert.notEqual(index, -1, `unknown position ${req.fen}`);
    return Promise.resolve({
      depth: 12,
      score: { cp: AFTER[index]! },
      pv: this.pv(req.fen),
    });
  }

  /** The engine's own idea, where it has one: Bc4 instead of the knight sortie. */
  pv(fen: string): string[] {
    return fen === steps[4]!.fen ? ['f1c4', 'f8c5'] : ['e1e1'];
  }
}

test('a self-analysed game feeds the finder like an exported one', async () => {
  const engine = new Fake();
  const analysis = await analyseGame(engine, steps, { pov: 'white' });

  const found = findCandidates(MOVES, analysis, { pov: 'white' });
  assert.deepEqual(
    found.map(c => c.index),
    [4],
  );
  assert.equal(found[0]!.best, 'f1c4');
  // The variation is written as SAN from the position before the move, the way
  // the lichess export writes it.
  assert.deepEqual(found[0]!.variation, ['Bc4', 'Bc5']);
});

test('pass 2 only touches plies the sweep flagged, on our side', async () => {
  const engine = new Fake();
  await analyseGame(engine, steps, { pov: 'white' });
  const sweep = engine.seen.filter(r => r.depth !== undefined);
  const deep = engine.seen.filter(r => r.movetime !== undefined);
  assert.equal(sweep.length, steps.length, 'every position swept');
  // Exactly one swing on a white ply -> one before, one after.
  assert.equal(deep.length, 2);
  assert.equal(deep[0]!.fen, steps[4]!.fen);
  assert.equal(deep[1]!.fen, steps[4]!.after);
});

test('the engine agreeing with the move played leaves no variation', async () => {
  class Agrees extends Fake {
    // From the position before ply 5, the engine's first choice is the move
    // that was actually played there.
    override pv(fen: string): string[] {
      return fen === steps[4]!.fen ? [steps[4]!.uci] : super.pv(fen);
    }
  }
  const analysis = await analyseGame(new Agrees(), steps, { pov: 'white' });
  assert.equal(analysis[4]!.variation, undefined);
  assert.deepEqual(findCandidates(MOVES, analysis, { pov: 'white' }), []);
});

test('fromPly keeps the opening out of pass 2', async () => {
  const engine = new Fake();
  await analyseGame(engine, steps, { pov: 'white', fromPly: 12 });
  assert.equal(
    engine.seen.filter(r => r.movetime !== undefined).length,
    0,
    'nothing deep-searched before the middlegame',
  );
});
