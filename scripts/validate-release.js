'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

function parseStableVersion(value) {
  const match = String(value || '').trim().match(/^(?:v)?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Stabil versiya formatı düzgün deyil: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function validateLocalVersion(projectRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const version = packageJson.version;
  parseStableVersion(version);

  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    throw new Error('package.json və package-lock.json versiyaları uyğun deyil.');
  }
  if (!renderer.includes(`<title>Meyar ERP — Uçot sistemi v${version}</title>`) || !renderer.includes(`const APP_VERSION='${version}'`)) {
    throw new Error('Renderer versiyası package.json ilə uyğun deyil.');
  }
  return version;
}

function fetchLatestReleaseVersion(repository, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'meyar-erp-release-validator',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = https.request({
      hostname: 'api.github.com',
      path: `/repos/${repository}/releases/latest`,
      method: 'GET',
      headers
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode === 404) return resolve(null);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`GitHub son buraxılış yoxlaması alınmadı: HTTP ${response.statusCode}`));
        }
        try {
          const release = JSON.parse(body);
          resolve(String(release.tag_name || '').replace(/^v/, ''));
        } catch (error) {
          reject(new Error(`GitHub buraxılış cavabı oxunmadı: ${error.message}`));
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('GitHub buraxılış yoxlamasının vaxtı bitdi.')));
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const version = validateLocalVersion(projectRoot);
  const gitReference = String(process.env.GITHUB_REF || '');

  if (gitReference.startsWith('refs/tags/') && gitReference !== `refs/tags/v${version}`) {
    throw new Error(`Git tag və proqram versiyası uyğun deyil: ${gitReference} / v${version}`);
  }

  if (String(process.env.MEYAR_VALIDATE_AGAINST_LATEST || '').toLowerCase() === 'true') {
    const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
    if (!repository) throw new Error('GITHUB_REPOSITORY göstərilməyib.');
    const latestVersion = await fetchLatestReleaseVersion(repository, process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '');
    if (latestVersion && compareVersions(version, latestVersion) <= 0) {
      throw new Error(`Yeni buraxılış versiyası v${latestVersion}-dan böyük olmalıdır; cari paket v${version}-dır.`);
    }
  }

  process.stdout.write(`Release contract v${version}: OK\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  compareVersions,
  fetchLatestReleaseVersion,
  parseStableVersion,
  validateLocalVersion
};
