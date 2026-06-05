import * as ClaudeAgentSDKModule from "@anthropic-ai/claude-agent-sdk";
import { instrumentSDK } from "./instrumentation.js";

// The Claude Agent SDK is ESM and exposes a frozen namespace, so the
// OpenInference instrumentation cannot patch it in place. Spreading into a
// regular object gives us a mutable copy that `manuallyInstrument` can edit.
const patched: typeof ClaudeAgentSDKModule = { ...ClaudeAgentSDKModule };
instrumentSDK(patched);

// Re-export the entire SDK surface so this package is a drop-in replacement.
// New SDK exports flow through automatically.
export * from "@anthropic-ai/claude-agent-sdk";

// Override the un-patched bindings re-exported above with the instrumented
// copies. The explicit local export takes precedence over the `export *`
// re-export, so callers get the patched version.
export const query = patched.query;
