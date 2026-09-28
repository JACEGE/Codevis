import { Clock } from '../shared/Clock';
import { LoanRepository } from '../repositories/LoanRepository';
import { Notifier } from './Notifier';
import { formatDueDate } from './templates';

export class ReminderScheduler {
  constructor(private loans: LoanRepository, private notifier: Notifier, private clock: Clock) {}
  sendDueSoonReminders(daysAhead = 2): number {
    const now = this.clock.now();
    const limit = now.getTime() + daysAhead * 86_400_000;
    const dueSoon = this.loans.all().filter(loan => !loan.returnedAt && loan.dueAt.getTime() <= limit && !loan.isOverdue(now));
    dueSoon.forEach(loan => this.notifier.send(loan.member, 'Due soon', `${loan.item.label()} is due ${formatDueDate(loan.dueAt)}`));
    return dueSoon.length;
  }
  sendOverdueNotices(): number {
    const overdue = this.loans.overdue(this.clock.now());
    overdue.forEach(loan => this.notifier.send(loan.member, 'Overdue', `${loan.item.label()} was due ${formatDueDate(loan.dueAt)}`));
    return overdue.length;
  }
}
