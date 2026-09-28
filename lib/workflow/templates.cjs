'use strict';
const KINDS=Object.freeze(['feature','bug','refactor','research','architecture','tech-debt']);
const STANDARD=Object.freeze({id:'engineering',version:1,phases:['requirements','analysis','architecture','planning','development','quality','review']});
const TEMPLATES=Object.freeze({engineering:STANDARD});
function templateSnapshot(id='engineering') {
  const template=TEMPLATES[id];if(!template)throw new Error('Unknown CodeFlow template');
  return structuredClone(template);
}
function flowKind(kind='feature') { if(!KINDS.includes(kind))throw new Error('Unknown Flow kind');return kind; }
const KIND_GOALS={bug:'Capture expected behavior and reproduction first; define a regression TestCase before fixing the cause.',refactor:'Capture behavior-preservation constraints and test intent before changing structure.',research:'Record the question, constraints and measurable evidence needed to decide next steps.',architecture:'Record architectural constraints and testable compatibility expectations.', 'tech-debt':'Describe the existing debt and measurable improvement while preserving required behavior.'};
module.exports={KINDS,TEMPLATES,templateSnapshot,flowKind,KIND_GOALS};
