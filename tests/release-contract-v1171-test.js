'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareVersions,
  parseStableVersion,
  validateLocalVersion
} = require('../scripts/validate-release');

const projectRoot = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'windows-release.yml'), 'utf8');
const main = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(projectRoot, 'src', 'styles-v1170.css'), 'utf8');

assert.deepEqual(parseStableVersion('v1.17.1'), [1, 17, 1]);
assert.equal(compareVersions('1.17.1', '1.17.0'), 1);
assert.equal(compareVersions('1.17.1', '1.17.1'), 0);
assert.equal(compareVersions('1.16.9', '1.17.0'), -1);
assert.throws(() => parseStableVersion('1.17'), /formatı düzgün deyil/);
assert.equal(validateLocalVersion(projectRoot), '1.17.1');

assert.match(workflow, /Validate monotonic release version/);
assert.match(workflow, /MEYAR_VALIDATE_AGAINST_LATEST/);
assert.match(workflow, /CSC_LINK: \$\{\{ secrets\.WINDOWS_CSC_LINK \}\}/);
assert.match(workflow, /CSC_KEY_PASSWORD: \$\{\{ secrets\.WINDOWS_CSC_KEY_PASSWORD \}\}/);
assert.match(main, /Created-By: Meyar ERP \$\{app\.getVersion\(\)\}/);
assert.doesNotMatch(main, /const APP_RELEASE\s*=/);
assert.match(main, /recoverPendingUpdateData/);
assert.match(main, /event\?\.defaultPrevented/);
assert.match(renderer, /status\.phase==='error'/);
assert.match(renderer, /status\.canRetryInstall/);
assert.match(styles, /\.update-status\.error/);
assert.match(styles, /\.sidefoot \{[\s\S]*display: flex !important;[\s\S]*width: 44px !important;/);

console.log('release and updater contract v1.17.1: OK');
