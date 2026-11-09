// Document backends on Cloudflare KV (binding W365). JsonStore / IndicatorRequestStore use read/write; the formula
// library uses loadAll/upsert*, batched and written once per request (flush) to stay inside the free write quota.
export function documentBackend(kv) {
  return {
    label:'cloudflare-kv',
    // A missing document reads as {} (JsonStore then starts from its defaults) instead of null, which would make
    // JsonStore write the defaults right away: a visitor who only looks must not cost a KV write.
    read:async (key) => (await kv.get(key, 'json')) ?? {},
    write:(key, value) => kv.put(key, JSON.stringify(value))
  };
}

export function formulaBackend(kv, key = 'formula-library') {
  let data = null, dirty = false;
  const load = async () => (data ??= (await kv.get(key, 'json')) || { formulas:[], aliases:[] });
  return {
    async loadAll() { const stored = await load(); return { formulas:[...stored.formulas], aliases:[...stored.aliases] }; },
    async upsertFormula(formula) { const stored = await load(); const at = stored.formulas.findIndex((item) => item.fingerprint === formula.fingerprint); if (at >= 0) stored.formulas[at] = formula; else stored.formulas.push(formula); dirty = true; },
    async upsertAlias(alias) { const stored = await load(); const at = stored.aliases.findIndex((item) => item.aliasNorm === alias.aliasNorm); if (at >= 0) stored.aliases[at] = alias; else stored.aliases.push(alias); dirty = true; },
    async flush() { if (dirty && data) { await kv.put(key, JSON.stringify(data)); dirty = false; } }
  };
}
