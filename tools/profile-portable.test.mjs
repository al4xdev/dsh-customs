import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { applyPortable, loadYaml, planPortable } from './profile-portable.mjs';

const hash16 = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Synthetic profile generated under another HOME; no owner profile is read.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'profile-portable-'));
  const fromHome = '/home/lab-owner';
  const profileDir = join(home, '.dsh/profiles/dsh-tui');
  mkdirSync(profileDir, { recursive: true });
  const leaf = `- id: liangshen-tool\n  name: ${fromHome}/git/my/dsh-customs/frontend/dsh-tui/presets/liangshen/tool.mjs\n`;
  const leafName = `alex-research-${hash16(leaf)}.yml`;
  const parent = `- id: alex-research-liangshen-plugins\n  name: '@deepseek-ai/cordis-plugin-include'\n  config:\n    path: ${fromHome}/.dsh/profiles/dsh-tui/${leafName}\n`;
  const parentName = `alex-research-${hash16(parent)}.yml`;
  writeFileSync(join(profileDir, leafName), leaf);
  writeFileSync(join(profileDir, parentName), parent);
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `# owner comment stays
- insert:
    - id: alex-apply-patch
      name: ${fromHome}/git/my/dsh-customs/plugins/apply-patch/index.mjs
    - id: alex-music
      name: ${fromHome}/git/my/dsh-customs/plugins/music/index.mjs
      config:
        path: ${fromHome}/Pictures/generated
    - id: preset-liangshen
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        plugins:
          - id: liangshen-plugins
            name: '@deepseek-ai/cordis-plugin-include'
            config:
              path: ${fromHome}/.dsh/profiles/dsh-tui/${parentName}
`);
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { tui: `link:${fromHome}/git/my/dsh-customs/frontend/dsh-tui`, base: '0.2.0-rc.2' } }, null, 2) + '\n');
  return { home, fromHome, profileDir, leafName, parentName };
}

test('absolute loader paths become profile-relative, research hashes cascade, plain config paths stay', () => {
  const f = fixture();
  const YAML = loadYaml(join(import.meta.dirname, '..'));
  const plan = planPortable({ profileDir: f.profileDir, fromHome: f.fromHome, home: f.home, YAML });
  assert.equal(plan.proven, true);
  const byFile = Object.fromEntries(plan.changes.map(change => [change.file, change]));
  const patch = byFile['cordis.patch.yml'].out;
  assert.match(patch, /^# owner comment stays/);
  assert.match(patch, /name: \.\.\/\.\.\/\.\.\/git\/my\/dsh-customs\/plugins\/apply-patch\/index\.mjs/);
  assert.match(patch, new RegExp(`path: ${f.fromHome}/Pictures/generated`), 'plugin-owned config path must stay absolute');
  const newLeaf = plan.renames[f.leafName], newParent = plan.renames[f.parentName];
  assert.equal(newLeaf, `alex-research-${hash16(byFile[f.leafName].out)}.yml`);
  assert.equal(newParent, `alex-research-${hash16(byFile[f.parentName].out)}.yml`);
  assert(byFile[f.parentName].out.includes(`path: ./${newLeaf}`));
  assert(patch.includes(`path: ./${newParent}`));
  assert.equal(JSON.parse(byFile['package.json'].out).dependencies.tui, 'link:../../../git/my/dsh-customs/frontend/dsh-tui');
  assert.equal(JSON.parse(byFile['package.json'].out).dependencies.base, '0.2.0-rc.2');
  assert.equal(resolve(f.profileDir, '../../../git/my'), join(f.home, 'git/my'));

  const backup = applyPortable(plan);
  assert(existsSync(join(backup, 'cordis.patch.yml')) && existsSync(join(backup, f.leafName)));
  assert.deepEqual(readdirSync(f.profileDir).filter(name => name.startsWith('alex-research-')).sort(), [newLeaf, newParent].sort());
  assert.equal(readFileSync(join(f.profileDir, newLeaf), 'utf8'), byFile[f.leafName].out);
  const again = planPortable({ profileDir: f.profileDir, fromHome: f.home, home: f.home, YAML });
  assert.deepEqual(again.changes, [], 'conversion must be idempotent');
});

test('a rerun after a partial write accepts identical targets and refuses foreign ones', () => {
  const f = fixture();
  const YAML = loadYaml(join(import.meta.dirname, '..'));
  const plan = planPortable({ profileDir: f.profileDir, fromHome: f.fromHome, home: f.home, YAML });
  const leaf = plan.changes.find(change => change.file === f.leafName);
  // Simulates the earlier EXDEV failure: the new name was written, nothing else.
  writeFileSync(join(f.profileDir, leaf.newFile), leaf.out);
  const again = planPortable({ profileDir: f.profileDir, fromHome: f.fromHome, home: f.home, YAML });
  applyPortable(again);
  assert(!existsSync(join(f.profileDir, f.leafName)) && existsSync(join(f.profileDir, leaf.newFile)));
  assert.deepEqual(readdirSync(f.profileDir).filter(name => name.includes('portable-tmp')), []);

  const g = fixture();
  const other = planPortable({ profileDir: g.profileDir, fromHome: g.fromHome, home: g.home, YAML });
  const target = other.changes.find(change => change.file === g.leafName).newFile;
  writeFileSync(join(g.profileDir, target), 'someone else\n');
  assert.throws(() => applyPortable(other), /refusing to overwrite/);
  assert(existsSync(join(g.profileDir, g.leafName)), 'nothing is removed when refusing');
});
