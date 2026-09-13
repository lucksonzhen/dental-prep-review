// 展示层统一配色；按解剖标签映射，不修改网格、标签或扫描原色。
// 肩台采用独立色相/明度，与五牙面及其他肩台子区区分。
export const DISPLAY_PALETTE = Object.freeze({
  0: '#98a4ae',
  1: '#f3bd45',
  2: '#63b4fa',
  3: '#9471df',
  4: '#55c9a1',
  5: '#f38c9b',
  6: '#9e9e9e',
  7: '#c51b36',
  8: '#966000',
  9: '#2448b3',
  10: '#00633e',
});
export const SHOULDER_IDS = Object.freeze([7, 8, 9, 10]);
export const SHOULDER_NAMES = Object.freeze({
  7: '唇 / 颊侧肩台',
  8: '舌侧肩台',
  9: '近中肩台',
  10: '远中肩台',
});
