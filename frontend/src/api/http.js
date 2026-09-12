export class HttpError extends Error {
  constructor(message, { status = 0, body = null, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

export async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('requestJson needs a fetch implementation');
  const response = await fetchImpl(url, options);
  const body = await responseBody(response);
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? body.error : null;
    throw new HttpError(detail || `HTTP ${response.status}`, { status: response.status, body, url });
  }
  return body;
}
