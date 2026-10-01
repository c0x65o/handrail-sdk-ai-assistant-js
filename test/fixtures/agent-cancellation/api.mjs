// Keep Agent dependency resolution inside the locked fixture package. The test
// itself resolves the candidate AI SDK through its own public package exports.
export { createAgentConversationTransport, createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
export { createJobAdmission } from 'handrail-agent-sdk/server';
export { default as pg } from 'pg';
export { z } from 'zod';
// Baseline reproduction uses the frozen public AI dependency of this Agent pin.
export { createHandrailAssistant as baselineAssistant } from '@handrail/ai-assistant/server/assistant';
