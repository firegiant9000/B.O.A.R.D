/**
 * Manual mock for `firebase/firestore`, used by service-layer unit tests.
 *
 * Why mock instead of @firebase/rules-unit-testing: the services import a singleton
 * `db` hardwired to the production Firebase project (src/config/firebase.ts). Running
 * against the emulator would require refactoring that singleton and standing up the
 * emulator in CI. Mocking keeps service tests fast, deterministic, and prod-safe.
 * Emulator-backed rules tests are deferred to the Month 3 workspace/rules work.
 *
 * Query-builder functions (collection/doc/query/where/orderBy) return opaque tokens
 * so tests can assert path arguments. Data functions (addDoc/getDocs/...) are bare
 * jest.fn()s configured per test.
 */

export const collection = jest.fn((_db: unknown, ...path: string[]) => ({
  __type: "collection",
  path,
}));

export const doc = jest.fn((_db: unknown, ...path: string[]) => ({
  __type: "doc",
  path,
  ref: { __type: "ref", path },
}));

export const query = jest.fn((...args: unknown[]) => ({ __type: "query", args }));

export const where = jest.fn((field: string, op: string, value: unknown) => ({
  __type: "where",
  field,
  op,
  value,
}));

export const orderBy = jest.fn((field: string, dir: string = "asc") => ({
  __type: "orderBy",
  field,
  dir,
}));

export const addDoc = jest.fn();
export const getDocs = jest.fn();
export const getDoc = jest.fn();
export const updateDoc = jest.fn(async () => undefined);
export const deleteDoc = jest.fn(async () => undefined);
export const setDoc = jest.fn(async () => undefined);
export const onSnapshot = jest.fn(() => jest.fn());

export const serverTimestamp = jest.fn(() => "__serverTimestamp__");
export const deleteField = jest.fn(() => "__deleteField__");
export const arrayUnion = jest.fn((...values: unknown[]) => ({
  __type: "arrayUnion",
  values,
}));
export const arrayRemove = jest.fn((...values: unknown[]) => ({
  __type: "arrayRemove",
  values,
}));

export const writeBatch = jest.fn(() => ({
  delete: jest.fn(),
  set: jest.fn(),
  update: jest.fn(),
  commit: jest.fn(async () => undefined),
}));

export const Timestamp = {
  fromDate: jest.fn((d: Date) => ({ __type: "timestamp", toDate: () => d })),
};

// --- test helpers (not part of the real firebase/firestore surface) ---

/** Builds a fake QueryDocumentSnapshot. */
export function makeDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    ref: { id, __type: "ref" },
    data: () => data,
    exists: () => true,
  };
}

/** Builds a fake QuerySnapshot from an array of [id, data] entries. */
export function makeQuerySnap(entries: Array<[string, Record<string, unknown>]>) {
  const docs = entries.map(([id, data]) => makeDoc(id, data));
  return { empty: docs.length === 0, size: docs.length, docs };
}

/** Builds a fake DocumentSnapshot (single doc get). */
export function makeDocSnap(
  id: string,
  data: Record<string, unknown> | null
) {
  return {
    id,
    exists: () => data !== null,
    data: () => data ?? undefined,
    ref: { id, __type: "ref" },
  };
}

/** Wraps a Date so `.toDate()` works like a Firestore Timestamp on read. */
export function ts(date: Date) {
  return { toDate: () => date };
}
