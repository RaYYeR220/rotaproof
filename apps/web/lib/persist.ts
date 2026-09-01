'use client';

/**
 * Where the roster lives between visits.
 *
 * IndexedDB rather than localStorage for two reasons: a solved week with its receipt and
 * conflict explanation is comfortably past what a synchronous string store should be
 * carrying, and writing it must not block the frame. Nothing is ever sent anywhere — this
 * is the only persistence in the application.
 *
 * Records are keyed by role. A manager's draft and a staff member's view of the same week
 * are different working states, and one must not overwrite the other.
 */

import { type IDBPDatabase, openDB } from 'idb';
import type { Role, RosterSession } from '@rotaproof/registry';

const DATABASE = 'rotaproof';
const STORE = 'sessions';

/** Everything except `solving`, which is a fact about this tab rather than about the week. */
export type PersistedSession = Omit<RosterSession, 'solving'>;

let handle: Promise<IDBPDatabase> | undefined;

function database(): Promise<IDBPDatabase> | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  handle ??= openDB(DATABASE, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
  return handle;
}

export async function loadSession(role: Role): Promise<PersistedSession | undefined> {
  const db = await database();
  if (!db) return undefined;
  try {
    return (await db.get(STORE, role)) as PersistedSession | undefined;
  } catch {
    return undefined;
  }
}

export async function saveSession(role: Role, session: RosterSession): Promise<void> {
  const db = await database();
  if (!db) return;
  const { solving: _solving, ...rest } = session;
  try {
    // Structured clone rejects anything React or the solver client might have attached.
    await db.put(STORE, JSON.parse(JSON.stringify(rest)) as PersistedSession, role);
  } catch {
    // A full or blocked database must not take the page down with it; the week is still
    // in memory and the next write will try again.
  }
}

export async function clearStoredSessions(): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    await db.clear(STORE);
  } catch {
    // Nothing to recover: the caller wanted the stored week gone, and it is either gone
    // or unreachable, which amounts to the same thing for this session.
  }
}
