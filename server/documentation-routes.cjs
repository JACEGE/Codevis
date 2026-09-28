'use strict';
const { readDocumentationFile } = require('./documentation-files.cjs');
const GUIDES = Object.freeze({overview:'README.md',changes:'docs/CHANGES_GUIDE.md',architecture:'docs/CHANGE_INTELLIGENCE.md'});
function registerDocumentationRoutes(app, packageRoot) {
  app.get('/api/docs', (req, res) => {
    const { file, guide } = req.query;
    if (file !== undefined && guide !== undefined) return res.status(400).json({error:'Select either a documentation file or a guide.'});
    if (file !== undefined && typeof file !== 'string' || guide !== undefined && (typeof guide !== 'string' || !Object.hasOwn(GUIDES, guide))) {
      return res.status(404).json({error:'Unknown documentation guide'});
    }
    try {
      const document = readDocumentationFile(packageRoot, file ?? GUIDES[guide || 'overview']);
      res.set('X-CodeVis-Document', document.relative);
      res.type('text/markdown').send(document.markdown);
    } catch (error) { res.status(error.status || 500).json({error:error.message}); }
  });
}
module.exports = { GUIDES, registerDocumentationRoutes };
