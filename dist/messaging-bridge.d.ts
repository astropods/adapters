import type { AgentAdapter, ServeOptions } from "./types";
export declare class MessagingBridge {
    private adapter;
    private serverAddress;
    private client;
    private stream;
    constructor(adapter: AgentAdapter, options?: ServeOptions);
    private connectWithRetry;
    start(): Promise<void>;
    private handleMessage;
    stop(): void;
}
//# sourceMappingURL=messaging-bridge.d.ts.map