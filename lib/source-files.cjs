"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isTestBasename } = require("../scripts/test-file.cjs");

// Keep aligned with the parser registry; extension-parity.test.js checks this.
const SOURCE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs", ".py", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".go", ".rs", ".java", ".rb", ".kt", ".kts", ".sh", ".bash", ".lua", ".xml"];

// The subset of IGNORED_DIRS that is about tests rather than about build
// output. Only these are lifted when a sourceDir explicitly names a test tree.
const TEST_DIRS = new Set(['__tests__', '__mocks__', 'tests', 'test', 'e2e']);

// Directories that never belong in a code-intelligence graph.
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.codevis', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', '__pycache__', '__tests__', '__mocks__', 'tests', 'test', 'e2e',
  '.idea', '.gradle', '.vscode', '.claude', '.codex',
  // Pythons Abhängigkeiten liegen IM Projekt, nicht daneben. Ohne diese
  // Einträge indiziert ein Python-Projekt seine virtuelle Umgebung mit:
  // gemessen an einem echten Projekt 4.297 Dateien aus .venv gegen 56 eigene,
  // Faktor 77. Der Graph füllt sich dann mit absl, numpy und torch, während
  // der Code, um den es geht, hinten in der Warteschlange steht — und weil
  // `.venv` alphabetisch vorn liegt, sieht man zuerst ausschließlich fremdes.
  //
  // `site-packages` und `dist-packages` stehen zusätzlich dabei, weil eine
  // Umgebung auch anders heißen kann als die üblichen Verzeichnisnamen.
  '.venv', 'venv', '.virtualenv', 'site-packages', 'dist-packages',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'eggs', '.eggs',
  // CMake legt seine Artefakte ebenfalls im Projekt ab. Rusts `target/` steht
  // hier bewusst NICHT: verglichen wird ein einzelner Verzeichnisname, und
  // `target` ist als Quellverzeichnis zu verbreitet, um es blind zu ignorieren.
  'cmake-build-debug', 'cmake-build-release',
]);

// Test files pollute the graph: they add nodes the user never wrote against
// (e.g. a `run`/`fetch` callee from a smoke test) and inflate false-positive
// CALLS edges. Exclude them by default so the graph reflects production code.
// Die Regeln selbst stehen in scripts/test-file.cjs, geteilt mit der
// Impact-Analyse. Die kannte nur `tests/` und `foo.test.js` und hielt damit
// für Produktivcode, was hier ausgeschlossen wird.
const isTestFile = isTestBasename;

/** Compile a project-relative glob without pulling in a glob dependency. */
function globToRegExp(glob) {
  const normalized = String(glob).split(path.sep).join('/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') {
      i++;
      if (normalized[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[\\^$.[\]{}()+|]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function compileExcludeMatchers(exclude) {
  if (!Array.isArray(exclude)) return [];
  return exclude.filter((glob) => typeof glob === 'string' && glob.length > 0).map(globToRegExp);
}

function isExcluded(filePath, baseDir, matchers) {
  if (!matchers || matchers.length === 0) return false;
  const relativePath = path.relative(baseDir, filePath).split(path.sep).join('/').replace(/^\.\/+/, '');
  // A trailing `/**` also applies to the directory itself, before traversal.
  return matchers.some((matcher) => matcher.test(relativePath) || matcher.test(`${relativePath}/`));
}

/**
 * Collect source files under `dir`.
 *
 * `opts.includeTests` lifts BOTH test filters (the IGNORED_DIRS entries for
 * test folders and the isTestFile name check) for this tree. It is set when the
 * user pointed a sourceDir at a test directory by name.
 *
 * Why that distinction exists: skipping tests during recursive discovery is a
 * sensible default — they roughly double the graph and are rarely what an agent
 * is asked about. Applying the same rule to a directory the user listed
 * EXPLICITLY in the config is not a default, it is overriding an instruction.
 * That is what happened here: `./tests` was configured, 16 files were dropped,
 * and nothing said so.
 */
function findFiles(dir, exts, fileList = [], opts = {}, ancestors = new Set()) {
  const { includeTests = false, baseDir = dir, excludeMatchers = [], sourceErrors = [] } = opts;
  let files;
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
    if (process.platform === 'win32') realDir = realDir.toLowerCase();
    if (ancestors.has(realDir)) return fileList;
    files = fs.readdirSync(dir);
  } catch (err) {
    sourceErrors.push({ path: dir, code: err.code, message: err.message });
    return fileList;
  }
  const nextAncestors = new Set(ancestors).add(realDir);
  for (const file of files) {
    // Build artefacts and dependencies stay ignored even inside an explicitly
    // configured tree — nobody means `node_modules` when they say `./tests`.
    if (IGNORED_DIRS.has(file) && !(includeTests && TEST_DIRS.has(file))) continue;
    const filePath = path.join(dir, file);
    if (isExcluded(filePath, baseDir, excludeMatchers)) continue;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      sourceErrors.push({ path: filePath, code: err.code, message: err.message });
      continue;
    }
    if (stat.isDirectory()) {
      findFiles(filePath, exts, fileList, opts, nextAncestors);
    } else {
      if (exts.includes(path.extname(filePath)) && (includeTests || !isTestFile(file))) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

// Explicit file roots and test directories keep the builder's existing semantics.
function collectSourceFiles(projectRoot, sourceDirs, { exclude = [], extensions = SOURCE_EXTENSIONS } = {}) {
  const roots = Array.isArray(sourceDirs) ? sourceDirs : sourceDirs ? [sourceDirs] : [];
  const excludeMatchers = compileExcludeMatchers(exclude);
  const files = [];
  const missingDirs = [];
  const testDirs = [];
  const sourceErrors = [];
  for (const dir of roots) {
    const fullPath = path.resolve(projectRoot, dir);
    if (isExcluded(fullPath, projectRoot, excludeMatchers)) continue;
    let stat;
    try { stat = fs.statSync(fullPath); }
    catch (err) {
      if (err.code === 'ENOENT') missingDirs.push({ dir, fullPath });
      sourceErrors.push({ path: fullPath, code: err.code, message: err.message });
      continue;
    }
    if (stat.isFile()) {
      files.push(fullPath);
      continue;
    }
    const includeTests = TEST_DIRS.has(path.basename(fullPath));
    const found = findFiles(fullPath, extensions, [], { includeTests, baseDir: projectRoot, excludeMatchers, sourceErrors });
    for (const file of found) files.push(file);
    if (includeTests) testDirs.push({ dir, count: found.length });
  }
  return { files: [...new Set(files)], missingDirs, testDirs, sourceErrors };
}

module.exports = { SOURCE_EXTENSIONS, IGNORED_DIRS, findFiles, globToRegExp, compileExcludeMatchers, collectSourceFiles };
