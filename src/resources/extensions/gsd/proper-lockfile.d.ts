declare module "proper-lockfile" {
  interface LockOptions {
    stale?: number;
    update?: number;
    realpath?: boolean;
    onCompromised?: (err?: Error) => void;
  }

  function lockSync(file: string, options?: LockOptions): () => void;
  function unlockSync(file: string, options?: { realpath?: boolean }): void;
  function lock(file: string, options?: LockOptions): Promise<() => void>;
  function unlock(file: string, options?: { realpath?: boolean }): Promise<void>;
  function check(file: string, options?: { stale?: number; realpath?: boolean }): Promise<boolean>;
  function checkSync(file: string, options?: { stale?: number; realpath?: boolean }): boolean;
}
