import { RoomRecordSchema, type ActionLogStore, type RoomRecord } from "./record.js";

/*
 * The slice of the IndexedDB API this store uses. The Room package has no DOM
 * types or globals (TECHNICAL_DESIGN.md §10.1), so the browser's `indexedDB`
 * is passed in and only needs to fit these shapes.
 */
interface IdbRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}
interface IdbObjectStore {
  put(value: unknown, key: string): IdbRequest<unknown>;
  get(key: string): IdbRequest<unknown>;
}
interface IdbTransaction {
  readonly error: unknown;
  objectStore(name: string): IdbObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}
interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(store: string, mode: "readonly" | "readwrite"): IdbTransaction;
  onversionchange: (() => void) | null;
  close(): void;
}
/** What the browser's `indexedDB` (an IDBFactory) offers that this store needs. */
export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequest;
}

const DB_VERSION = 1;
const STORE = "rooms";

/**
 * Keeps each Room's record in IndexedDB, keyed by Room Code, so it survives a
 * refresh of the Host's tab. Pass the browser's `indexedDB`.
 */
export class IndexedDbActionLogStore implements ActionLogStore {
  readonly #factory: IdbFactoryLike;
  readonly #dbName: string;
  #db: Promise<IdbDatabase> | null = null;

  constructor(indexedDB: IdbFactoryLike, dbName = "here-to-slay") {
    this.#factory = indexedDB;
    this.#dbName = dbName;
  }

  async save(record: RoomRecord): Promise<void> {
    // Copy now, so a caller mutating the record before the transaction runs changes nothing.
    const value = JSON.parse(JSON.stringify(record)) as RoomRecord;
    // Read-write transactions on the same store run in the order they were created,
    // and they are created in the order save() was called, so saves land in order.
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, value.roomCode);
    await done(tx);
  }

  async load(roomCode: string): Promise<RoomRecord | null> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readonly");
    const value = await result(tx.objectStore(STORE).get(roomCode));
    if (value === undefined) return null;
    // Storage outlives code versions and can be edited by hand, so check what comes back.
    return RoomRecordSchema.parse(value);
  }

  #open(): Promise<IdbDatabase> {
    this.#db ??= new Promise<IdbDatabase>((resolve, reject) => {
      let gaveUp = false;
      const request = this.#factory.open(this.#dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Opened after we stopped waiting on a blocked request: nobody will use it, so don't hold it open.
        if (gaveUp) return db.close();
        // Another tab upgrading the database: let it, and reopen on next use.
        db.onversionchange = () => {
          db.close();
          this.#db = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(toError(request.error));
      request.onblocked = () => {
        gaveUp = true;
        reject(new Error("IndexedDB is blocked by another open tab"));
      };
    }).catch((e: unknown) => {
      this.#db = null;
      throw e;
    });
    return this.#db;
  }
}

function result<T>(request: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toError(request.error));
  });
}

function done(tx: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toError(tx.error));
    tx.onabort = () => reject(toError(tx.error ?? new Error("IndexedDB transaction aborted")));
  });
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
