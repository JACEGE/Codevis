import { dashboardMatches } from '../../lib/dashboard-session.mjs';

/** The CLI prints its banner before the bridge binds: wait for the real API. */
export async function waitForDemoDashboard(url, identity, {
    fetchImpl = fetch, timeoutMs = 120_000, pollMs = 250, startupError = () => null,
} = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no response';
    do {
        const error = startupError();
        if (error) throw error;
        let status;
        try {
            const response = await fetchImpl(new URL('/api/status', url), { signal: AbortSignal.timeout(2000) });
            if (response.ok) status = await response.json();
            else lastError = `HTTP ${response.status}`;
        } catch (error) { lastError = error.message; }
        if (status) {
            if (!dashboardMatches(status, identity) || status.activeDb !== 'project_db') {
                throw new Error('Demo dashboard belongs to a different project, data directory or database');
            }
            return status;
        }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (Date.now() < deadline);
    throw new Error(`Demo dashboard did not become ready: ${lastError}`);
}
