import { LibraryController } from './api/LibraryController';
import { buildRoutes } from './api/router';
import { EmailNotifier } from './notifications/Notifier';
import { ReminderScheduler } from './notifications/ReminderScheduler';
import { CatalogRepository } from './repositories/CatalogRepository';
import { LoanRepository, ReservationRepository } from './repositories/LoanRepository';
import { MemberRepository } from './repositories/MemberRepository';
import { CirculationService } from './services/CirculationService';
import { FeeCalculator } from './services/FeeCalculator';
import { MembershipService } from './services/MembershipService';
import { ReservationService } from './services/ReservationService';
import { SearchService } from './services/SearchService';
import { Clock, SystemClock } from './shared/Clock';

export function createLibrary(clock: Clock = new SystemClock()) {
  const catalog = new CatalogRepository();
  const members = new MemberRepository();
  const loans = new LoanRepository();
  const reservationRepo = new ReservationRepository();
  const notifier = new EmailNotifier();
  const reservations = new ReservationService(catalog, members, reservationRepo, notifier, clock);
  const circulation = new CirculationService(catalog, members, loans, reservations, new FeeCalculator(), clock);
  const membership = new MembershipService(members, notifier);
  const search = new SearchService(catalog, circulation);
  const controller = new LibraryController(search, circulation, reservations, membership);
  const reminders = new ReminderScheduler(loans, notifier, clock);
  return { catalog, members, loans, notifier, reservations, circulation, membership, controller, reminders, routes: buildRoutes(controller) };
}
