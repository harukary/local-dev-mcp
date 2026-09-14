import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<AbortSignal>();

export function withRequestSignal<T>(signal: AbortSignal, operation: () => T): T {
  return requests.run(signal, operation);
}

export function requestSignal(): AbortSignal | undefined { return requests.getStore(); }

export function operationSignal(timeoutMs: number): AbortSignal {
  const signal = requestSignal();
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
