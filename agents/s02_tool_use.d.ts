declare module "node:child_process" {
  export function spawnSync(...args: any[]): any;
}

declare module "node:fs/promises" {
  export function readFile(...args: any[]): Promise<string>;
  export function writeFile(...args: any[]): Promise<void>;
  export function mkdir(...args: any[]): Promise<void>;
}

declare module "node:readline/promises" {
  export function createInterface(...args: any[]): {
    question(prompt: string): Promise<string>;
    close(): void;
  };
}

declare module "node:process" {
  export function cwd(): string;
  export const env: Record<string, string | undefined>;
  export const platform: string;
  export const stdin: any;
  export const stdout: any;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "@anthropic-ai/sdk" {
  export default class Anthropic {
    constructor(options?: any);
    messages: {
      create(args: any): Promise<any>;
    };
  }
}

declare module "dotenv" {
  const dotenv: {
    config(options?: any): any;
  };

  export default dotenv;
}
