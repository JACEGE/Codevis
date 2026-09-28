import { Member, MembershipTier } from '../domain/Member';
import { MemberRepository } from '../repositories/MemberRepository';
import { nextId } from '../shared/Ids';
import { RuleViolation } from '../shared/Result';
import { formatFee } from '../notifications/templates';
import { Notifier } from '../notifications/Notifier';

export class MembershipService {
  constructor(private members: MemberRepository, private notifier: Notifier) {}
  register(name: string, email: string, tier: MembershipTier = 'basic'): Member {
    if (this.members.findByEmail(email)) throw new RuleViolation('Email already registered');
    const member = this.members.save(new Member(nextId('mem'), name, email.toLowerCase(), tier));
    this.notifier.send(member, 'Welcome to Harbor Library', `Hello ${name}!`);
    return member;
  }
  payFees(memberId: string, amount: number): number {
    const member = this.members.findById(memberId);
    if (!member) throw new RuleViolation('Unknown member');
    member.pay(amount);
    this.notifier.send(member, 'Payment received', `Remaining balance ${formatFee(member.outstandingFees)}`);
    return member.outstandingFees;
  }
}
