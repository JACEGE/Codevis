let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString().padStart(5, '0')}`;
}

export function resetIds(): void { counter = 0; }
