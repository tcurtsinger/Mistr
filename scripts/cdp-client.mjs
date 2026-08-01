export class CdpClient {
  constructor(socket, defaultTimeoutMs = 15_000) {
    this.socket = socket;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => this.rejectAll(new Error("CDP socket error"));
    socket.onclose = () => this.rejectAll(new Error("CDP socket closed"));
  }

  call(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new RangeError("CDP request timeout must be positive"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.rejectAll(new Error("CDP client closed"));
    this.socket.close();
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.rejectAll(new Error("CDP socket returned malformed JSON"));
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    this.pending.delete(message.id);
    request.resolve(message);
  }

  rejectAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export function openWebSocketWithTimeout(socket, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new RangeError("WebSocket handshake timeout must be positive"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      complete();
    };
    const timeout = setTimeout(() => finish(() => {
      socket.close();
      reject(new Error(`CDP WebSocket handshake timed out after ${timeoutMs} ms`));
    }), timeoutMs);
    socket.onopen = () => finish(resolve);
    socket.onerror = () => finish(() => reject(new Error("CDP WebSocket handshake failed")));
    socket.onclose = () => finish(() => reject(
      new Error("CDP WebSocket closed before the handshake completed"),
    ));
  });
}

export async function fetchJsonWithTimeout(
  url,
  timeoutMs = 1_000,
  fetchImplementation = globalThis.fetch,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("HTTP request timeout must be positive");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`HTTP request timed out after ${timeoutMs} ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
