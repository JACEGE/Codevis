'use strict';

const os = require('node:os');
const originalUserInfo = os.userInfo;
os.userInfo = function safeUserInfo(...args) {
  try {
    return originalUserInfo.apply(this, args);
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'ERR_SYSTEM_ERROR') throw error;
    return {
      uid: -1, gid: -1,
      username: process.env.USERNAME || 'codevis',
      homedir: process.env.USERPROFILE || process.cwd(),
      shell: null,
    };
  }
};
