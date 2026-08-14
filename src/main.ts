import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { App } from './ui/app.ts';
import { ensureIsolation } from './isolation.ts';

// One reload, at most, before the app starts: see isolation.ts. The report is
// handed to the app so that "the engine is unavailable" can say why.
void ensureIsolation().then(report => {
  new App(document.getElementById('app')!, report).start();
});
