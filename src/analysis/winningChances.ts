// Port of lila ui/lib/src/ceval/winningChances.ts — keep it recognisable.
// See CLAUDE.md: these thresholds are load-bearing.

export type Color = 'white' | 'black';

export interface EvalScore {
  cp?: number;
  mate?: number;
}

const toPov = (color: Color, diff: number): number => (color === 'white' ? diff : -diff);

/** https://github.com/lichess-org/lila/pull/11148 */
const rawWinningChances = (cp: number): number => {
  const MULTIPLIER = -0.00368208;
  return 2 / (1 + Math.exp(MULTIPLIER * cp)) - 1;
};

const cpWinningChances = (cp: number): number => rawWinningChances(Math.min(Math.max(-1000, cp), 1000));

const mateWinningChances = (mate: number): number => {
  const cp = (21 - Math.min(10, Math.abs(mate))) * 100;
  return rawWinningChances(cp * (mate > 0 ? 1 : -1));
};

const evalWinningChances = (ev: EvalScore): number =>
  ev.mate !== undefined ? mateWinningChances(ev.mate) : cpWinningChances(ev.cp!);

/** 1 = infinitely winning for `color`, -1 = infinitely losing. */
export const povChances = (color: Color, ev: EvalScore): number => toPov(color, evalWinningChances(ev));

/** Difference in winning chances between two evaluations. */
export const povDiff = (color: Color, e1: EvalScore, e2: EvalScore): number =>
  (povChances(color, e1) - povChances(color, e2)) / 2;
