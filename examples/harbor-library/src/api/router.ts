import { LibraryController, Response } from './LibraryController';

type Handler = (params: Record<string, string>) => Response;

export function buildRoutes(controller: LibraryController): Record<string, Handler> {
  return {
    'GET /search': params => controller.handleSearch(params.q ?? ''),
    'POST /loans': params => controller.handleBorrow(params.memberId, params.itemId),
    'POST /returns': params => controller.handleReturn(params.loanId),
    'POST /reservations': params => controller.handleReserve(params.memberId, params.itemId),
    'POST /members': params => controller.handleRegister(params.name, params.email),
  };
}

export function dispatch(routes: Record<string, Handler>, method: string, path: string, params: Record<string, string>): Response {
  const handler = routes[`${method} ${path}`];
  return handler ? handler(params) : { status: 404, body: { error: 'Unknown route' } };
}
