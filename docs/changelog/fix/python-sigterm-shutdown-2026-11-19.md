# Exit the Python bridge promptly on SIGTERM

## Summary

A Python agent ignored SIGTERM. The signal handler only set a stop flag, and `start()` kept reading the `ProcessConversation` stream. That stream closes only when the messaging sidecar stops. In Kubernetes the native sidecar stops only after the agent container exits, so the agent ran until SIGKILL at the end of the termination grace period. Every node drain and single-replica redeploy waited out the full grace period.

The TypeScript bridge already exits on SIGTERM. The Python bridge now does the same.

## Design

`start()` runs the stream reader as its own task and waits on the stop event. On SIGINT, SIGTERM, or a direct `stop()` call, it shuts down in this order:

| Step | Effect |
| --- | --- |
| Stop dispatch | The reader drops any message that arrives after the stop. |
| Abort turns | In-flight turns are canceled and end quietly, like a user stop: no END chunk, no error. The sidecar owns finalization. |
| Drain the writer | Responses already queued are written, then the bridge half-closes the stream (`done_writing`). The drain waits at most `SHUTDOWN_DRAIN_TIMEOUT_S` (5 seconds). |
| Close | The reader task and the call are canceled, and the channel is closed. |

`start()` then returns, so `serve()` exits with status 0. `TestShutdown` in `packages/core-py/tests/test_bridge.py` covers both `stop()` and a real SIGTERM against a stream that never closes.

Aborting matches the TypeScript bridge's `stop()`. Letting turns finish within the grace period is a possible later change, once the platform sizes the grace period to `agent.response_timeout`.

## Migration

None. Update `astropods-adapter-core` and redeploy.
