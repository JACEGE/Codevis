'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { key, validateState } = require('./model.cjs');
const digest = text => createHash('sha256').update(text).digest('hex');
function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Artifact path must be repository-relative');
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Artifact path escapes project');
  let current = root;
  for (const part of rel.split(path.sep)) {
    if (['.git', '.codevis', 'node_modules'].includes(part.toLowerCase())) throw new Error('Artifacts must be versionable project files');
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Artifact symlinks are not supported');
  }
  return absolute;
}
function artifactRoot(projectRoot, config, workspace) {
  if (!['project_db', 'codevis_db'].includes(workspace)) throw new Error('Invalid workflow workspace');
  const dir = config.workflow?.artifactDir || 'docs/codevis';
  return contained(projectRoot, path.join(dir, 'changes', workspace));
}
function changeDirectory(options, slug) {
  key(slug, 'slug');
  return contained(options.projectRoot, path.relative(options.projectRoot,
    path.join(artifactRoot(options.projectRoot, options.config || {}, options.workspace), slug)));
}
function readState(options, slug) {
  const filename = contained(options.projectRoot, path.relative(options.projectRoot, path.join(changeDirectory(options, slug), 'state.json')));
  const text = fs.readFileSync(filename, 'utf8');
  const state = validateState(JSON.parse(text));
  if (state.slug !== slug || state.workspace !== options.workspace) throw new Error('Change belongs to a different workspace or slug');
  return { state, hash: digest(text) };
}
function atomicWrite(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); } catch (e) { fs.unlinkSync(temporary); throw e; }
}
function saveState(options, state, previousHash = null) {
  validateState(state);
  const filename = contained(options.projectRoot, path.relative(options.projectRoot, path.join(changeDirectory(options, state.slug), 'state.json')));
  if (fs.existsSync(filename)) {
    if (previousHash == null || digest(fs.readFileSync(filename, 'utf8')) !== previousHash) throw new Error('CONFLICT: Change state changed; read it again');
  } else if (previousHash != null) throw new Error('CONFLICT: Change state was removed');
  atomicWrite(filename, JSON.stringify(state, null, 2) + '\n');
}
function listStates(options) {
  const base = artifactRoot(options.projectRoot, options.config || {}, options.workspace);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => readState(options, x.name).state);
}
function writeArtifact(options, state, phase, content) {
  key(phase, 'phase');
  const name = phase + '-r' + state.revision + '-' + digest(content).slice(0,12) + '.md';
  const filename = contained(options.projectRoot, path.relative(options.projectRoot, path.join(changeDirectory(options, state.slug), name)));
  if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') !== content) throw new Error('Artifact conflict');
  if (!fs.existsSync(filename)) atomicWrite(filename, content);
  return { path: path.relative(options.projectRoot, filename).replace(/\\/g, '/'), sha256: digest(content), phase, revision: state.revision };
}
function readArtifact(options, artifact) {
  const content = fs.readFileSync(contained(options.projectRoot, artifact.path), 'utf8');
  if (digest(content) !== artifact.sha256) throw new Error('Artifact changed since submission: ' + artifact.path);
  return content;
}
module.exports = { digest, contained, artifactRoot, changeDirectory, readState, saveState, listStates, writeArtifact, readArtifact };
