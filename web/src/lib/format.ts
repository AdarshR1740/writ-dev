export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "cost unknown for this model";
  if (usd < 0.01) return "under 1¢";
  return `about $${usd.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
