export function formatDueDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatFee(amount: number): string {
  return '$' + amount.toFixed(2);
}
