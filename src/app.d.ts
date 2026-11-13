// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

// Vite `?worker` imports — the chunk's default export is a `Worker` constructor.
declare module '*?worker' {
  const WorkerConstructor: {
    new (options?: { name?: string }): Worker;
  };
  export default WorkerConstructor;
}

export {};
