/**
 * React bindings with no DOM elements or react-dom dependency.
 *
 * This is the supported React Native and custom-renderer entry point. Native
 * applications own their View/Text/TextInput presentation while sharing the
 * same typed runtime, state selectors, and actions as browser React clients.
 */
export {
  ConversationProvider,
  type ConversationFactoryProviderProps,
  type ConversationProviderFactory,
  type ConversationProviderProps,
  type ConversationReadableStore,
  type ConversationRuntimeProviderProps,
  type ConversationStoreProviderProps,
  type ConversationStoreRuntimeProviderProps,
} from "../react/context.js";
export {
  useConversationActions,
  useConversationSelector,
  useConversationSnapshot,
  useConversationStore,
  type ConversationActions,
} from "../react/hooks.js";
export {
  useConversationLauncherBinding,
  useConversationWorkspaceSnapshot,
  type ConversationActivityReadable,
  type ConversationActivityRecord,
  type ConversationLauncherBinding,
  type ConversationWorkspaceReadable,
} from "../react/workspace.js";

export { useConversationApprovals, type ConversationApprovalResources } from "../react/use-conversation-approvals.js";

export { useRealtimeWorkspaceActivity } from "../react/realtime-workspace.js";
export { useConversationTitles, type UseConversationTitlesOptions } from "../react/use-conversation-titles.js";

export { useComposerApprovalPreference } from "../react/composer-approval-preference.js";
