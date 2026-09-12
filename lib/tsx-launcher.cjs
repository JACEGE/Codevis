#!/usr/bin/env node
'use strict';

// tsx asks os.userInfo() only to choose a temporary-directory suffix. On some
// Windows hosts that syscall can fail with ERR_SYSTEM_ERROR/ENOMEM even though
// Node and the filesystem are otherwise healthy. Do not let optional username
// discovery prevent the MCP server from starting; preserve every other error.
const { pathToFileURL } = require('node:url');
const preload = require.resolve('./tsx-userinfo-preload.cjs');
require(preload);
const existingNodeOptions = process.env.NODE_OPTIONS || '';
if (!existingNodeOptions.includes('tsx-userinfo-preload.cjs')) {
  const portablePreload = preload.replace(/\\/g, '/');
  process.env.NODE_OPTIONS = `${existingNodeOptions} --require=\"${portablePreload}\"`.trim();
}

import(pathToFileURL(require.resolve('tsx/cli')).href).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
