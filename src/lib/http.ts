/**
 * HTTP utilities for provider API calls.
 */

import { REQUEST_TIMEOUT_MS } from "./types.js";

export type FetchWithTimeoutOptions<T> = {
  request: Omit<RequestInit, "signal">;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  consume: (response: Response, timeoutSignal: AbortSignal) => Promise<T> | T;
};

/**
 * Fetch and consume a response within one timeout.
 *
 * The response consumer must complete all status handling, body reads, and parsing
 * before returning so the request signal remains active for the full transaction.
 *
 * @throws Error with message "Request timeout after Xs" if the transaction times out
 */
export async function fetchWithTimeout<T>(
  url: string,
  options: FetchWithTimeoutOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutErrorMessage = `Request timeout after ${Math.round(timeoutMs / 1000)}s`;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);
  });

  try {
    const transaction = (async () => {
      const fetchFn = options.fetchFn ?? globalThis.fetch;
      const response = await fetchFn(url, {
        ...options.request,
        signal: controller.signal,
      });
      return await options.consume(response, controller.signal);
    })();
    return await Promise.race([transaction, timeout]);
  } catch (err) {
    if (timedOut) {
      throw new Error(timeoutErrorMessage);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a response body with a hard byte cap and parse it as JSON.
 *
 * Checks the declared content length first, then enforces the cap while
 * streaming so an oversized body is abandoned early.
 */
export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.body) throw new Error("empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("response too large");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or size-limit error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(body));
}

/**
 * Replace a full Cookie header and every individual cookie value inside a
 * message with "[redacted]", so request errors can be surfaced without leaking
 * the session.
 */
export function redactCookieSecrets(message: string, cookie: string): string {
  let redacted = message;
  for (const secret of [cookie, ...cookieSecretValues(cookie)]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function cookieSecretValues(cookie: string): string[] {
  return cookie.split(";").flatMap((part) => {
    const value = part.slice(part.indexOf("=") + 1).trim();
    if (!value) return [];
    const unquoted = value.replace(/^"(.*)"$/u, "$1");
    return unquoted === value ? [value] : [value, unquoted];
  });
}
