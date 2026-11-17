/**
 * An amount the way Indonesian prices are written: `125000` → `Rp 125.000`.
 * Used in messages only; amounts travel as whole rupiah.
 */
export function formatRupiah(amount: number): string {
  const digits = Math.abs(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `${amount < 0 ? '-' : ''}Rp ${digits}`;
}
