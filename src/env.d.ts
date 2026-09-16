/// <reference types="vite/client" />

// The test hook shape; extended by gameplay issues that add state.
declare global {
  interface Window {
    __game?: {
      getState(): unknown;
      press(key: string): void;
    };
  }
}

export {};
