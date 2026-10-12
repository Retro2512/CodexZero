import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await fs.readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const script = workflow.match(/          script: \|\r?\n([\s\S]*?)(?=\r?\n  wrapper:)/)[1]
  .split('\n').map(line => line.replace(/^            /, '')).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', script);
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const baseline = workflow.replace(/^    (?:needs|if):.*\r?\n/gm, '');

async function evidence({ changed = ['src/sidebar-appearance.mjs'], previous = baseline, previousRelease = release, jobs, ancestor = true, unavailable = false } = {}) {
  const outputs = {};
  const git = (_command, args) => {
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'merge-base') {
      if (!ancestor) throw new Error('Not an ancestor');
      return '';
    }
    if (args[0] === 'diff') return changed.join('\0');
    if (args[0] === 'show') {
      const [commit, file] = args[1].split(':');
      if (file.endsWith('ci.yml')) return commit === head ? workflow : previous;
      return commit === head ? release : previousRelease;
    }
    throw new Error(`Unexpected git command ${args[0]}`);
  };
  await execute(() => ({ execFileSync: git }), {
    rest: { actions: {
      listWorkflowRuns: async (options) => {
        assert.equal(options.event, 'push');
        assert.equal(options.status, 'success');
        if (unavailable) throw new Error('Unavailable');
        return { data: { workflow_runs: [{ head_sha: base, id: 123, html_url: 'verified-run' }] } };
      },
      listJobsForWorkflowRun: () => {}
    } },
    paginate: async () => jobs ?? ['windows-latest', 'ubuntu-latest'].map(os => ({ name: `patch (${os})`, conclusion: 'success' }))
  }, { repo: { owner: 'owner', repo: 'repo' } }, {
    setOutput: (key, value) => { outputs[key] = value; }, info: () => {}
  });
  return outputs.rebuild;
}

test('CI reuses successful unchanged core evidence while wrapper and setup stay unconditional', async () => {
  assert.equal(await evidence(), 'false');
  for (const name of ['wrapper', 'setup']) {
    const job = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))[1];
    assert.doesNotMatch(job, /^    (?:if|needs):/m);
  }
  assert.match(workflow, /  patch:\r?\n    needs: core-evidence\r?\n    if: needs\.core-evidence\.outputs\.rebuild != 'false'/);
});

test('core input, pinned toolchain, regression and build changes require full verification', async () => {
  for (const file of ['patches/core.patch', 'config/compatibility.json', 'fixtures/core.json', '.cargo/config.toml', 'codex-rs/core/src/lib.rs', 'Cargo.lock', 'rust-toolchain.toml', 'scripts/core-upstream.json', 'scripts/build-provider-local.ps1', 'test/browser-discovery-patch.test.mjs', 'test/provider-glm-core.test.mjs', 'test/upstream-pin.test.mjs', '.github/workflows/new-core.yml']) {
    assert.equal(await evidence({ changed: [file] }), 'true', file);
  }
  assert.equal(await evidence({ previous: baseline.replace('1.95.0', '1.94.0') }), 'true');
  assert.equal(await evidence({ previous: baseline.replace('cargo test --locked', 'cargo test') }), 'true');
  assert.equal(await evidence({ previous: baseline.replace('jobs:', 'env:\n  RUSTFLAGS: custom\njobs:') }), 'true');
  assert.equal(await evidence({ previousRelease: release.replace('cargo build --locked', 'cargo build') }), 'true');
});

test('missing, skipped, failed and nonancestor evidence fail closed', async () => {
  assert.equal(await evidence({ unavailable: true }), 'true');
  assert.equal(await evidence({ ancestor: false }), 'true');
  assert.equal(await evidence({ jobs: [] }), 'true');
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    assert.equal(await evidence({ jobs: [{ name: 'patch (windows-latest)', conclusion: 'success' }, { name: 'patch (ubuntu-latest)', conclusion }] }), 'true');
  }
});
