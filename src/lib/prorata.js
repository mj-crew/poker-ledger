// Distribute `total` cents across weighted items so the parts sum EXACTLY to
// `total` (largest-remainder rounding). items: [{ id, weight }]. Returns { id: cents }.
export function allocateProrata(items, total) {
  const out = {};
  for (const i of items) out[i.id] = 0;
  const totalW = items.reduce((s, i) => s + i.weight, 0);
  if (totalW <= 0 || total <= 0) return out;
  const parts = items.map((i) => {
    const exact = (i.weight / totalW) * total;
    const cents = Math.floor(exact);
    return { id: i.id, cents, frac: exact - cents };
  });
  let remainder = total - parts.reduce((s, p) => s + p.cents, 0);
  parts.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder && parts.length; k++) parts[k % parts.length].cents += 1;
  for (const p of parts) out[p.id] = p.cents;
  return out;
}
