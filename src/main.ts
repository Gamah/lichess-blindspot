import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { App } from './ui/app.ts';
import { ensureIsolation, report } from './isolation.ts';

// One reload, at most, before the app starts: see isolation.ts. The report is
// handed to the app so that "the engine is unavailable" can say why.
//
// `ensureIsolation` is written not to reject, and this catches anyway: whatever
// goes wrong in there, a page that renders nothing at all is the one outcome
// worth ruling out.
void ensureIsolation()
  .catch(() => report())
  .then(isolation => {
    new App(document.getElementById('app')!, isolation).start();
  });
