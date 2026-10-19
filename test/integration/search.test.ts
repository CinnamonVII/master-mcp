/**
 * Full-text search tests.
 *
 * master_search exists so an agent can find a specific remembered detail after
 * the brief has been read. These tests cover the contract an agent relies on:
 * every memory kind is findable by its own vocabulary, filters work, results
 * are ranked, the no-hits case is explicit, and searching never writes.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { harness, writeFiles } from '../helpers/harness.ts';

const CONFIG = ['project: concurrent-studios', 'goal: Ship the offer system', ''].join('\n');

function register(h: ReturnType<typeof harness>): void {
  writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });
}

describe('master_search', () => {
  it('finds decisions, bugs and findings by their own vocabulary', async () => {
    const h = harness('search');
    try {
      register(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });
        const decision = service.record({
          kind: 'decision',
          body: 'Eligibility lives in the offer predicate',
          subsystem: 'industry-offer',
        });
        const bug = service.record({
          kind: 'bug',
          body: 'Ownership check passes for unverified offers',
          severity: 'high',
          subsystem: 'industry-offer',
        });
        const finding = service.record({
          kind: 'finding',
          body: 'The UI caches ownership client-side.',
          subsystem: 'industry-offer',
        });

        const byDecision = service.search({ query: 'eligibility predicate' });
        assert.equal(byDecision.hits[0]?.kind, 'decision');
        assert.equal(byDecision.hits[0]?.id, decision.id);
        assert.match(byDecision.text, /SEARCH "eligibility predicate"/);
        assert.match(byDecision.text, new RegExp(`scope: concurrent-studios \\(prj_[a-z0-9]+\\)`));
        assert.match(byDecision.text, /- \[decision\] Eligibility lives in the offer predicate · industry-offer \(dec_[a-z0-9]+\) \d+%/);
        assert.equal(byDecision.projectSlug, 'concurrent-studios');

        const byBug = service.search({ query: 'unverified offers' });
        assert.equal(byBug.hits[0]?.id, bug.id);
        assert.match(byBug.text, /- \[bug\] Ownership check passes for unverified offers · industry-offer/);

        const byFinding = service.search({ query: 'caches client-side' });
        assert.equal(byFinding.hits[0]?.id, finding.id);
        assert.match(byFinding.text, /- \[finding\] The UI caches ownership client-side\./);
      });
    } finally {
      h.cleanup();
    }
  });

  it('filters by kind and honours the limit', async () => {
    const h = harness('search');
    try {
      register(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });
        service.record({ kind: 'decision', body: 'Standardise offer ownership checks', subsystem: 'industry-offer' });
        const first = service.record({
          kind: 'bug',
          body: 'Offer ownership check ignores withdrawn offers',
          subsystem: 'industry-offer',
        });
        service.record({ kind: 'bug', body: 'Offer ownership check logs a warning', subsystem: 'industry-offer' });

        const bugsOnly = service.search({ query: 'offer ownership', kinds: ['bug'] });
        assert.ok(bugsOnly.hits.length >= 2);
        assert.ok(bugsOnly.hits.every((hit) => hit.kind === 'bug'));
        assert.match(bugsOnly.text, /kinds: bug/);
        assert.ok(!bugsOnly.text.includes('[decision]'));

        const limited = service.search({ query: 'offer ownership', kinds: ['bug'], limit: 1 });
        assert.equal(limited.hits.length, 1);
        assert.equal(limited.hits[0]?.id, first.id, 'the strongest match survives the limit');

        // Unknown kind names are ignored rather than erroring or filtering everything out.
        const unknownKind = service.search({ query: 'offer ownership', kinds: ['not-a-kind'] });
        assert.ok(unknownKind.hits.length >= 3);
        assert.ok(!unknownKind.text.includes('kinds:'));
      });
    } finally {
      h.cleanup();
    }
  });

  it('ranks the most relevant hit first', async () => {
    const h = harness('search');
    try {
      register(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });
        const strong = service.record({
          kind: 'bug',
          body: 'CSV export crashes on empty billing data',
          subsystem: 'billing',
        });
        const weak = service.record({ kind: 'bug', body: 'CSV export naming is inconsistent', subsystem: 'billing' });

        const result = service.search({ query: 'CSV export crashes empty billing' });
        assert.ok(result.hits.length >= 2);
        assert.equal(result.hits[0]?.id, strong.id);
        for (let index = 1; index < result.hits.length; index += 1) {
          assert.ok(
            (result.hits[index - 1]?.score ?? 0) >= (result.hits[index]?.score ?? 0),
            'scores must be non-increasing',
          );
        }
        assert.ok(result.text.indexOf(strong.id) < result.text.indexOf(weak.id), 'text order follows rank');
      });
    } finally {
      h.cleanup();
    }
  });

  it('reports no matches clearly and performs no writes', async () => {
    const h = harness('search');
    try {
      register(h);
      await h.with(async (service) => {
        await service.context({ task: 'Warm up project discovery' });
        service.record({ kind: 'bug', body: 'Ownership check passes for unverified offers' });

        const before = JSON.stringify(service.describe().projects);
        const result = service.search({ query: 'xylophone quantum' });
        assert.deepEqual(result.hits, []);
        assert.match(result.text, /No stored memory matched\. Record it with master_record if it should exist\./);
        assert.equal(JSON.stringify(service.describe().projects), before, 'search must not change stored memory');
      });
    } finally {
      h.cleanup();
    }
  });

  it('searches across all projects when nothing is registered yet', async () => {
    const h = harness('search');
    try {
      await h.with(async (service) => {
        const result = service.search({ query: 'anything at all' });
        assert.deepEqual(result.hits, []);
        assert.equal(result.projectSlug, null);
        assert.match(result.text, /scope: all projects allowed by the query/);
        assert.match(result.text, /No stored memory matched\./);
      });
    } finally {
      h.cleanup();
    }
  });
});
