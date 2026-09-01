/**
 * Actions that belong to this application rather than to the shared registry.
 *
 * They are written with the same `defineAction` the registry uses and run through the same
 * `runAction` helper, so a button here is a tool call in everything but where it came from.
 */

import { EMPTY_LEDGER, seedRoster } from '@rotaproof/core';
import { defineAction } from '@rotaproof/registry';

export const resetWeek = defineAction<Record<string, never>, unknown>({
  id: 'reset_week',
  title: 'Reset to the seeded week',
  order: 99,
  readOnly: false,
  roles: ['manager', 'staff'],
  available: (session) => !session.solving,
  description: 'Throws away every change and restores the café week this page ships with.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  agentExempt:
    'Discards the whole working week including published versions, with nothing to restore it from. A person pressing the button is the only consent that means anything here, and an agent cannot supply it.',
  async run(_args, { update }) {
    update((draft) => {
      draft.model = seedRoster();
      draft.ledger = EMPTY_LEDGER;
      draft.status = 'draft';
      draft.schedule = undefined;
      draft.lastResult = undefined;
      draft.swaps = [];
      draft.versions = [];
    });
    return { status: 'reset', week: seedRoster().horizon.startDate };
  },
});
