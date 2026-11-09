// Parses public/data/daily.json(.gz) (scripts/build-data.mjs) into the DailyStore series shape:
// Map(symbol → { dates, o, h, l, c, v }) with typed arrays, gaps (no bar that day) left out.
export function seriesFromDailyJson(data) {
  const series = new Map();
  for (const [symbol, list] of Object.entries(data.series || {})) {
    const dates = [], o = [], h = [], l = [], c = [], v = [];
    list.forEach((bar, slot) => {
      if (!bar || !Number.isFinite(bar[3])) return;
      dates.push(data.dates[slot]); o.push(fin(bar[0])); h.push(fin(bar[1])); l.push(fin(bar[2])); c.push(bar[3]); v.push(fin(bar[4]));
    });
    if (dates.length) series.set(symbol, { dates, o:Float64Array.from(o), h:Float64Array.from(h), l:Float64Array.from(l), c:Float64Array.from(c), v:Float64Array.from(v) });
  }
  return series;
}
const fin = (value) => (Number.isFinite(value) ? value : NaN);
