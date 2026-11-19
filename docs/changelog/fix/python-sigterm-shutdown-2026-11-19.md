# Exit the Python bridge promptly on SIGTERM

## Summary

A Python agent ignored SIGTERM. The signal handler only set a stop flag, and `start()` kept reading the `ProcessConversation` stream. That stream closes only when the messaging sidecar stops. In Kubernetes the native sidecar stops only after the agent container exits, so the agent ran until SIGKILL at the end of the termination grace period. Every node drain and single-replica redeploy waited out the full grace period.

The TypeScript bridge already exits on SIGTERM. The Python bridge now does the same. It also exits when the stream fails, instead of idling with no stream.

## Design

`start()` runs the stream reader as its own task. It waits for whichever comes first: a stop request or the end of the reader.

On SIGINT, SIGTERM, or `stop()`, it shuts down in this order:

| Step | Effect |
| --- | --- |
| Refuse new messages | A message that arrives after the stop gets START, then a retryable `PLATFORM_ERROR`: "The agent is restarting. Try again in a moment." No turn runs. |
| Abort turns | In-flight turns are canceled and end quietly, like a user stop: no END chunk, no error. The sidecar owns finalization. Shutdown waits at most `SHUTDOWN_TURN_TIMEOUT_S` (5 seconds) for turns that ignore the cancel. |
| Drain the writer | Queued responses are written, then the bridge half-closes the stream. The drain waits at most `SHUTDOWN_DRAIN_TIMEOUT_S` (5 seconds). |
| Close | The reader is canceled and the channel is closed, which ends the call. |

`start()` then returns.

When the reader ends first, the bridge runs the same shutdown and then raises. A reader error is raised as is, and a stream the server closed raises `ConnectionError`. `serve()` exits with status 1, so Kubernetes restarts the container and it reconnects. Before this change, a non-gRPC reader error escaped `start()`. A closed stream left the agent running with no stream.

`stop()` is safe to call from any thread. Off the loop thread, it schedules itself on the loop with `call_soon_threadsafe`.

`serve()` runs its own event loop instead of `asyncio.run`. `asyncio.run` joins the default executor's threads, and a canceled turn does not stop a blocking call that runs in a thread (`asyncio.to_thread`). After the loop closes, `serve()` waits up to `SHUTDOWN_THREAD_TIMEOUT_S` (5 seconds) for non-daemon threads. If any are still running, it runs the `atexit` handlers, flushes logging, and calls `os._exit`. Trace exporters registered with `atexit` still flush.

The worst-case shutdown is about 15 seconds: turns, drain, then threads.

`TestShutdown` and `TestServeExit` in `packages/core-py/tests/test_bridge.py` cover each path. Those paths are `stop()`, a real SIGTERM, a cross-thread stop, a turn that ignores the cancel, a message during shutdown, a closed stream, a reader error, and a stuck thread.

Aborting turns matches the TypeScript bridge's `stop()`. Letting turns finish within the grace period is a possible later change, once the platform sizes the grace period to `agent.response_timeout`.

## Migration

None. Update `astropods-adapter-core` and redeploy.
