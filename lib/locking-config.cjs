'use strict';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function parseLockingOverride(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

/**
 * Multi-agent locking is experimental and therefore opt-in. The environment
 * override is useful for one process/CI run; otherwise the project config is
 * authoritative. Unknown override values deliberately fall back to config.
 */
function isLockingEnabled(config, env = process.env) {
  const override = parseLockingOverride(env?.CODEVIS_LOCKING);
  if (override !== null) return override;
  return config?.locking?.enabled === true;
}

function lockingStatus(config, env = process.env) {
  const enabled = isLockingEnabled(config, env);
  return { enabled, mode: enabled ? 'enabled' : 'disabled' };
}

module.exports = { isLockingEnabled, lockingStatus, parseLockingOverride };
