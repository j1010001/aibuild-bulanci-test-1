// The only runtime globals the shared core may use beyond ECMAScript itself: Web Crypto,
// which browsers and Node (>= 19) both provide. Used by tsconfig.core.json only; the
// browser and server configs get these from their DOM / Node libraries instead.
declare var crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID?(): string;
};
