'use strict';

const fs = require('node:fs');

function removeTemporaryDirectory(directoryPath) {
  try {
    fs.rmSync(directoryPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  } catch (error) {
    const windowsRunnerLock = process.platform === 'win32'
      && ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
    if (!windowsRunnerLock) throw error;
    console.warn(`Windows test runner müvəqqəti qovluğu kilidli saxladı: ${directoryPath}`);
  }
}

module.exports = { removeTemporaryDirectory };
