#!/usr/bin/env node
/**
 * CodeVis Bash Guard — Blocks file-modifying bash commands on locked files.
 * Only active when CODEVIS_AGENT_ID is set.
 */

const { readFileSync, existsSync } = require('fs');
const { resolve, relative } = require('path');

// Derive agent ID: explicit env > teammate name > null (inactive)
const agentId = process.env.CODEVIS_AGENT_ID
    || (process.env.CLAUDE_CODE_TEAMMATE_NAME ? `worker-${process.env.CLAUDE_CODE_TEAMMATE_NAME}` : null);

if (!agentId) {
    allow();
    return;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (!isLockingEnabled(projectDir)) {
    allow();
    return;
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const data = JSON.parse(input);
        const command = data.tool_input?.command || '';

        // Patterns that modify files
        const dangerousPatterns = [
            /\bsed\s+-i/,
            /\bawk\s+.*-i\s+inplace/,
            /\bperl\s+(-\w+\s+)*-[a-z]*[ie]/,
            />{1,2}\s*[^\s|&;]+\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,  // redirect or append to source file
            /\btee\s+[^\s|&;]+\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,
            /\bcp\s+.*\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,
            /\bmv\s+.*\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,
            /\brm\s+.*\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,
            /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*\s+--recursive\s+)/,
            /\btruncate\b/,
            /\bdd\b.*of=/,
            /\bpython[23]?\s+(-\w+\s+)*-c\s/,
            /\bnode\s+(-\w+\s+)*-e\s/,
            /\bruby\s+(-\w+\s+)*-e\s/,
            /\bbash\s+-c\s/,
            /\bsh\s+-c\s/,
            /\bchmod\b.*\.(js|jsx|ts|tsx|mjs|cjs|mts|py|vue|svelte|json|yaml|yml|toml)\b/,
            /\bpatch\b/,
            /\bgit\s+(checkout|restore)\s+/,
            /\bcurl\s+.*-[a-zA-Z]*o\s/,
            /\bwget\s+.*-[a-zA-Z]*O\s/,
            /\btar\s+.*-?x/,
            /\bunzip\s+.*-o/,
            /\bln\s+.*-[a-zA-Z]*[sf]/,
            /\bxargs\s+/,
            /\bed\s+/,
            /\bex\s+/,
        ];

        const isFileModifying = dangerousPatterns.some(p => p.test(command));
        if (!isFileModifying) {
            allow();
            return;
        }

        // Extract file paths from the command
        const manifestPath = resolve(projectDir, '.claude/locks.json');

        if (!existsSync(manifestPath)) {
            allow();
            return;
        }

        let locks;
        try {
            locks = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        } catch {
            deny('Lock manifest corrupt or unreadable — blocking for safety.');
            return;
        }

        // Check if any locked file paths appear in the command
        for (const relFile of Object.keys(locks)) {
            const foreignLocks = locks[relFile].filter(l => l.lockedBy !== agentId);
            if (foreignLocks.length === 0) continue;

            const absFile = resolve(projectDir, relFile);
            const normalizedRel = relFile.replace(/\\/g, '/');
            const dotSlashRel = './' + normalizedRel;

            if (command.includes(relFile) || command.includes(absFile) || command.includes(dotSlashRel) || command.includes(normalizedRel)) {
                deny(`BLOCKED: Bash command modifies '${relFile}' which has functions locked by: ${foreignLocks.map(l => `'${l.name}' (${l.lockedBy})`).join(', ')}.`);
                return;
            }

            // Also check if command references a parent directory of a locked file
            const lockedDir = require('path').dirname(relFile);
            const dirSegments = lockedDir.split('/');
            for (let d = 0; d < dirSegments.length; d++) {
                const parentDir = dirSegments.slice(0, d + 1).join('/');
                if (command.includes(parentDir + '/') || command.includes(parentDir + ' ') || command.endsWith(parentDir)) {
                    // Only block if the command is a recursive delete
                    if (/\brm\s+(-[a-zA-Z]*r|\s*--recursive)/.test(command)) {
                        deny(`BLOCKED: Bash command recursively deletes '${parentDir}/' which contains locked file '${relFile}' (locked by: ${foreignLocks.map(l => `'${l.name}' (${l.lockedBy})`).join(', ')}).`);
                        return;
                    }
                }
            }
        }

        allow();
    } catch (err) {
        process.stderr.write(`bash-guard error: ${err.message}\n`);
        deny('bash-guard internal error — blocking for safety.');
    }
});

function allow() {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }
    }));
    process.exit(0);
}

function deny(reason) {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    }));
    process.exit(0);
}

function isLockingEnabled(projectDir) {
    const override = String(process.env.CODEVIS_LOCKING || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(override)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(override)) return false;
    try {
        const configPath = resolve(projectDir, 'codevis.config.cjs');
        return existsSync(configPath) && require(configPath)?.locking?.enabled === true;
    } catch {
        return false;
    }
}
