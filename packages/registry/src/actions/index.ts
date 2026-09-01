import type { ActionDefinition } from '../types.js';

import { MANAGER_ACTIONS } from './manager.js';
import { STAFF_ACTIONS } from './staff.js';

export * from './manager.js';
export * from './staff.js';

/**
 * Every capability of the application, in registration order.
 *
 * Both surfaces read this list: the UI to decide what to render, the WebMCP binding to
 * decide what to register. Nothing else is allowed to define a capability, which is what
 * makes `parity.test.ts` a meaningful guarantee rather than a spot check.
 */
export const ALL_ACTIONS = [...MANAGER_ACTIONS, ...STAFF_ACTIONS] as unknown as ActionDefinition<
  never,
  unknown
>[];

/** Actions an agent can see in a given session. Mirrors the binding's own filter. */
export function agentActions(role: 'manager' | 'staff'): ActionDefinition<never, unknown>[] {
  return ALL_ACTIONS.filter((a) => !a.agentExempt && a.roles.includes(role)).sort(
    (a, b) => a.order - b.order,
  );
}
