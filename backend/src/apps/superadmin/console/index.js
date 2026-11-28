const express = require('express');
const path = require('path');
const { pathToFileURL } = require('url');
const { tsImport } = require('tsx/esm/api');

const apiModuleUrl = pathToFileURL(
  path.resolve(__dirname, '..', 'console-api', 'index.ts'),
).href;
const parentUrl = pathToFileURL(__filename).href;

function createSuperadminConsole(options = {}) {
  const router = express.Router();
  let initializePromise;

  return {
    router,
    initialize(bootstrap) {
      if (!initializePromise) {
        initializePromise = (async () => {
          const { createSuperadminRouter } = await tsImport(apiModuleUrl, parentUrl);
          router.use(await createSuperadminRouter({
            bootstrap,
            storage: 'database',
            sessionRepository: options.sessionRepository,
          }));
        })().catch((error) => {
          initializePromise = undefined;
          throw error;
        });
      }

      return initializePromise;
    },
  };
}

module.exports = { createSuperadminConsole };