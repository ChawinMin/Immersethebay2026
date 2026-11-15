/**
 * Bun and Node ambient type definitions for build scripts in this workspace.
 */

declare module "fs/promises" {
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}

declare module "module" {
  export interface RequireFunction {
    (id: string): any
    resolve(id: string): string
  }
  export const createRequire: (filename: string | URL) => RequireFunction
}

declare module "path" {
  export function resolve(...paths: string[]): string
  export function dirname(path: string): string
  export function join(...paths: string[]): string
}

declare module "node:path" {
  export function resolve(...paths: string[]): string
}

interface ImportMeta {
  dir: string
  url: string
}

declare const process: {
  env: Record<string, string | undefined>
  exit(code?: number): never
}

declare const Bun: {
  build(options: {
    entrypoints: string[]
    outdir: string
    target?: string
    format?: string
    minify?: boolean
    define?: Record<string, string>
    plugins?: any[]
  }): Promise<{
    success: boolean
    logs: any[]
  }>
}
