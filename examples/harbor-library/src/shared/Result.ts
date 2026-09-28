export class DomainError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) { super('NOT_FOUND', `${entity} ${id} not found`); }
}

export class RuleViolation extends DomainError {
  constructor(message: string) { super('RULE_VIOLATION', message); }
}

export function assertFound<T>(value: T | undefined, entity: string, id: string): T {
  if (value === undefined) throw new NotFoundError(entity, id);
  return value;
}
