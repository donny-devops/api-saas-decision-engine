const money = (s) => {
  const m = String(s).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  const value = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(value) && value <= 1e15 ? value : null;
};
