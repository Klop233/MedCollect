declare module "cloudflare:workers" {
  export const env: import("./lib/worker-env").WorkerEnv;
}
