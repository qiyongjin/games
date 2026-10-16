import { searchBestMove } from './search.js';

self.addEventListener('message', event => {
  const { id, position, difficulty, entries } = event.data ?? {};
  try {
    self.postMessage({ id, result: searchBestMove(position, { difficulty, entries }) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
