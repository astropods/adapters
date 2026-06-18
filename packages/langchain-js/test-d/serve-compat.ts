/**
 * Type-only guard: a real `createAgent()` agent must stay assignable to
 * `serve()`, `LangChainAdapter`, and `ensureCheckpointer()`. This is the
 * "seamless import" contract — if a LangChain release changes the agent's
 * shape, this file fails to typecheck (see the `typecheck` script) before it
 * reaches a user.
 *
 * Never imported at runtime and excluded from the build; it exists only to be
 * checked by `tsc --noEmit`.
 */
import { createAgent } from "langchain";
import {
  serve,
  LangChainAdapter,
  ensureCheckpointer,
} from "../src/index";

const agent = createAgent({
  model: "openai:gpt-4o",
  tools: [],
  systemPrompt: "You are helpful.",
});

// The real agent satisfies every public entry point without a cast.
serve(agent, { name: "Compat" });
new LangChainAdapter(agent);
ensureCheckpointer(agent);
