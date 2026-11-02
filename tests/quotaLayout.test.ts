import { expect, test } from 'bun:test';
import { stackQuotaColumns } from '../src/services/quotaLayout';

test('stacked layout puts each card in the shortest column, keeping order within columns', () => {
  // Worked by hand: 10 -> col 0; 2, 2, 2 -> col 1 (2, 4, 6); 8 -> col 1 (6 < 10, now 14); 1 -> col 0 (10 < 14).
  expect(stackQuotaColumns([10, 2, 2, 2, 8, 1], 2)).toEqual([[0, 5], [1, 2, 3, 4]]);
  // Equal heights fill left to right, like the grid.
  expect(stackQuotaColumns([1, 1, 1, 1, 1], 3)).toEqual([[0, 3], [1, 4], [2]]);
  expect(stackQuotaColumns([3, 1], 0)).toEqual([[0, 1]]);
});
