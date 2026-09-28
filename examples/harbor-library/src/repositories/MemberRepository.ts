import { Member } from '../domain/Member';
import { InMemoryRepository } from './Repository';

export class MemberRepository extends InMemoryRepository<Member> {
  findByEmail(email: string): Member | undefined {
    return this.all().find(member => member.email === email.toLowerCase());
  }
  withFees(): Member[] { return this.all().filter(member => member.outstandingFees > 0); }
}
