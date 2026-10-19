/**
 * Terminology-aware retrieval through the real service.
 *
 * The service records free prose; ranking, search and dedup must all see the
 * same canonical terms behind that prose. These tests drive master_context and
 * master_record end to end rather than calling normalization helpers directly.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { harness, section, writeFiles } from '../helpers/harness.ts';

const CONFIG = [
  'project: offer-service',
  'goal: Ship the offer system',
  'phase: implementation',
  'subsystems:',
  '  - industry-offer',
  '',
].join('\n');

const KNOWN_BUG = 'Support tooling still shows offers the viewer does not own';
const PARAPHRASED_TASK = 'Fix the technology ownership regression bug';
const UNRELATED_OWNER_BUG = 'The owner field is nullable in the billing export';
const HISTORY = 'RELEVANT HISTORY';

function seed(h: ReturnType<typeof harness>): void {
  writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });
}

describe('terminology-aware retrieval', () => {
  it('surfaces the stored own/ownership bug for the paraphrased ownership task', async () => {
    const h = harness('retrieval');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });

        // Age the bug so severity/recency cannot lift it over the threshold on
        // their own: only terminology and full-text overlap can make it match.
        h.clock.set('2024-01-01T00:00:00.000Z');
        const bug = service.record({
          kind: 'bug',
          body: KNOWN_BUG,
          severity: 'low',
          subsystem: 'industry-offer',
        });
        h.clock.set('2026-03-01T09:00:00.000Z');

        const search = service.search({ query: 'ownership' });
        assert.ok(
          search.hits.some((hit) => hit.id === bug.id),
          `expected full-text search to find ${bug.id}; hits: ${search.hits.map((hit) => hit.id).join(',') || 'none'}`,
        );

        const brief = await service.context({ task: PARAPHRASED_TASK });
        assert.ok(
          brief.brief.bugs.some((entry) => entry.id === bug.id),
          `expected ${bug.id} in the brief; selected: ${brief.brief.bugs.map((entry) => entry.id).join(',') || 'none'}`,
        );
        assert.match(section(brief.text, HISTORY), new RegExp(KNOWN_BUG));
      });
    } finally {
      h.cleanup();
    }
  });

  it('does not merge or outrank the ownership regression bug with an unrelated owner record', async () => {
    const h = harness('retrieval');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });
        const known = service.record({
          kind: 'bug',
          body: KNOWN_BUG,
          severity: 'high',
          subsystem: 'industry-offer',
        });
        const unrelated = service.record({
          kind: 'bug',
          body: UNRELATED_OWNER_BUG,
          severity: 'low',
          subsystem: 'billing',
        });
        assert.notEqual(unrelated.id, known.id, 'sharing only "ownership" must not merge two reports');
        assert.ok(!/already matches this report/.test(unrelated.text));

        const brief = await service.context({ task: PARAPHRASED_TASK });
        assert.equal(brief.brief.bugs[0]?.id, known.id, 'the true ownership bug stays first');
        assert.match(section(brief.text, HISTORY), new RegExp(KNOWN_BUG));
      });
    } finally {
      h.cleanup();
    }
  });
});
