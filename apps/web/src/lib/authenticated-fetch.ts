export class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired. Sign in to continue.');
    this.name = 'SessionExpiredError';
  }
}

let sessionValidation: Promise<boolean> | undefined;

function validateSession(): Promise<boolean> {
  sessionValidation ??= fetch('/api/v1/session')
    .then(response => {
      const expired = response.status === 401;
      if (expired) window.dispatchEvent(new Event('hypermail:session-expired'));
      return expired;
    })
    .catch(() => false)
    .finally(() => { sessionValidation = undefined; });
  return sessionValidation;
}

/** Validate a failed authentication without replaying the original operation. */
export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && await validateSession()) {
    throw new SessionExpiredError();
  }
  return response;
}
