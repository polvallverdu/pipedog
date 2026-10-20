// Minimal typing for AsyncLocalStorage so the package does not depend on
// @types/node. Available on Node, Bun, Deno and Cloudflare Workers (with the
// `nodejs_compat` or `nodejs_als` compatibility flag).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
