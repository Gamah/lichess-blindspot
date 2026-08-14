import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { App } from './ui/app.ts';
import { ensureIsolation } from './isolation.ts';

// One reload, at most, before the app starts: see isolation.ts.
void ensureIsolation().then(() => {
  new App(document.getElementById('app')!).start();
});
