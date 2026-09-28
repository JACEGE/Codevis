'use strict';
const requirements = {
  markdown:'# Requirements\nA rotated refresh token must never be accepted again. Preserve active sessions and reject expired tokens.',
  data:{problem:'Token reuse enables an expired session to continue.',desiredBehavior:'Rotate a token once and reject every subsequent reuse.',scope:'Refresh token rotation for existing sessions.',nonGoals:'No changes to password sign in or email delivery.',constraints:'Preserve existing session identifiers and expiry semantics.',assumptions:'Callers can retry requests concurrently.',openQuestions:[]},
  entities:[
    {id:'REQ-1',label:'Requirement',title:'Reject used refresh tokens',content:'Previously used refresh tokens must be rejected.'},
    {id:'AC-1',label:'AcceptanceCriterion',title:'Reject token after rotation',content:'Given a valid token, when rotated, then reusing the original fails.'},
    {id:'TC-1',label:'TestCase',title:'Reusing original token fails',content:'Rotate a token then retry the original and expect rejection.',reason:'Protect the acceptance criterion against token replay.'}],
  links:[{from:'change',to:'REQ-1',type:'HAS_REQUIREMENT'},{from:'REQ-1',to:'AC-1',type:'HAS_CRITERION'},{from:'AC-1',to:'TC-1',type:'VALIDATED_BY'}],
};
module.exports={requirements};
