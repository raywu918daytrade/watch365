export function calculateUniverseCoverage(watchlist, universeItems) {
  const coveredSymbols = new Set(universeItems.map((item) => String(item.symbol)));
  const items = watchlist.map((item) => ({
    ...item,
    coverage: coveredSymbols.has(String(item.symbol)) ? 'covered' : 'uncovered'
  }));
  const covered = items.filter((item) => item.coverage === 'covered').length;
  return {
    counts: { selected: items.length, covered, uncovered: items.length - covered },
    items
  };
}
