// Rules and network moves always use the red-side coordinates. Only the view rotates.
// A half-turn is its own inverse, so this also maps a visible square back to the board.
export function viewSquare(index, side = 'red') {
  return side === 'black' ? 89 - index : index;
}

export function adjacentSquare(index, key, side = 'red') {
  const visible = viewSquare(index, side);
  const row = Math.floor(visible / 9), col = visible % 9;
  const steps = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  const step = steps[key];
  if (!step) return index;
  const nextRow = row + step[0], nextCol = col + step[1];
  if (nextRow < 0 || nextRow > 9 || nextCol < 0 || nextCol > 8) return index;
  return viewSquare(nextRow * 9 + nextCol, side);
}

export function fileLabels(side = 'red') {
  return side === 'black'
    ? { top: [...'一二三四五六七八九'], bottom: [...'987654321'] }
    : { top: [...'123456789'], bottom: [...'九八七六五四三二一'] };
}
