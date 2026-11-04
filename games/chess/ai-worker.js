// Runs the computer's thinking off the main thread so the board never freezes.
importScripts('engine.js');

onmessage = e => {
  const { moves, level } = e.data;
  const game = replay(moves);
  postMessage(game ? bestMove(game.state, level) : null);
};
