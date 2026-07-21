export const PROVIDER_QUEUE_BINDINGS = Object.freeze({
  ashby: "QUEUE_ASHBY",
  bamboohr: "QUEUE_BAMBOOHR",
  gem: "QUEUE_GEM",
  getro: "QUEUE_GETRO",
  greenhouse: "QUEUE_GREENHOUSE",
  icims: "QUEUE_ICIMS",
  lever: "QUEUE_LEVER",
  paylocity: "QUEUE_PAYLOCITY",
  sparkhire: "QUEUE_SPARKHIRE",
  workday: "QUEUE_WORKDAY",
});

export const ACTIVE_REFRESH_HOURS = 12;
export const EMPTY_REFRESH_HOURS = 96;
export const INVALID_REFRESH_HOURS = 24 * 30;
export const ERROR_BASE_DELAY_MINUTES = 15;

export function queueForProvider(env, provider) {
  const binding = PROVIDER_QUEUE_BINDINGS[provider];
  return binding ? env[binding] : null;
}

export function nextSyncAt(status, failureCount = 0, now = Date.now()) {
  let milliseconds;
  if (status === "active") milliseconds = ACTIVE_REFRESH_HOURS * 60 * 60 * 1_000;
  else if (status === "empty") milliseconds = EMPTY_REFRESH_HOURS * 60 * 60 * 1_000;
  else if (status === "invalid") milliseconds = INVALID_REFRESH_HOURS * 60 * 60 * 1_000;
  else {
    const minutes = Math.min(24 * 60, ERROR_BASE_DELAY_MINUTES * 2 ** Math.max(0, failureCount));
    milliseconds = minutes * 60 * 1_000;
  }
  return new Date(now + milliseconds).toISOString();
}
