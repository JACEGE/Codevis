import { Member } from '../domain/Member';

export interface Notifier {
  send(member: Member, subject: string, body: string): void;
}

export class EmailNotifier implements Notifier {
  sent: { to: string; subject: string }[] = [];
  send(member: Member, subject: string, body: string): void {
    this.sent.push({ to: member.email, subject });
    if (!body) throw new Error('Empty notification body');
  }
}

export class SmsNotifier implements Notifier {
  constructor(private gateway: (to: string, text: string) => void) {}
  send(member: Member, subject: string): void { this.gateway(member.id, subject); }
}
