// Lane layout for the commit graph. Pure logic, no DOM, so it is unit-testable.
//
// Input: commits in topological order (children before parents), each { hash, parents: [hash] }.
// Output: one row per commit: { col, segments, width } where each segment is
//   { from, to, half: 'top' | 'bottom', color }
// 'top' segments run from the top edge of the row to the node (or straight through),
// 'bottom' segments run from the node to the bottom edge. Columns are lane indexes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GraphLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PALETTE_SIZE = 8;

  function layout(commits) {
    const rows = [];
    let lanes = []; // lanes[i] = hash of the commit that lane i is waiting for, or null

    for (const commit of commits) {
      const segments = [];
      const incoming = lanes.slice();

      // Every lane waiting for this commit converges on it; the first one is its column.
      let col = incoming.indexOf(commit.hash);
      if (col === -1) {
        col = incoming.indexOf(null);
        if (col === -1) col = incoming.length;
      }

      const next = incoming.slice();
      while (next.length <= col) next.push(null);

      incoming.forEach((h, i) => {
        if (h === null) return;
        if (h === commit.hash) {
          segments.push({ from: i, to: col, half: 'top', color: i % PALETTE_SIZE });
          next[i] = null;
        } else {
          // Lane passes straight through this row.
          segments.push({ from: i, to: i, half: 'top', color: i % PALETTE_SIZE });
          segments.push({ from: i, to: i, half: 'bottom', color: i % PALETTE_SIZE });
        }
      });

      // Hand the commit's lane to its parents.
      commit.parents.forEach((parent, idx) => {
        let target = next.indexOf(parent);
        if (target === -1) {
          if (idx === 0 && next[col] === null) target = col;
          else {
            target = next.indexOf(null);
            if (target === -1) target = next.length;
          }
          while (next.length <= target) next.push(null);
          next[target] = parent;
        }
        segments.push({ from: col, to: target, half: 'bottom', color: target % PALETTE_SIZE });
      });

      while (next.length && next[next.length - 1] === null) next.pop();
      const width = Math.max(incoming.length, next.length, col + 1);
      rows.push({ col, segments, width, color: col % PALETTE_SIZE });
      lanes = next;
    }
    return rows;
  }

  return { layout, PALETTE_SIZE };
});
