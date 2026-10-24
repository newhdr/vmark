/**
 * WebSocketBridge configuration surface.
 *
 * Holds the public option types (`WebSocketBridgeConfig`, `Logger`,
 * `ClientIdentity`, `PortResolver`) and the ONE place their defaults are
 * applied. `websocket.ts` re-exports the public names, so this split is
 * invisible to consumers.
 */

/**
 * Logger interface for WebSocketBridge.
 * Compatible with console, pino, winston, etc.
 */
export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Default no-op logger (silent).
 */
const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Client identification sent during WebSocket handshake.
 *
 * **Display only.** VMark shows `name` in Settings > Integrations and in its
 * logs; it reaches no authorization decision there. Authorization binds to the
 * verified credential from `clientTokenResolver` instead — `name` is a guess
 * (see `utils/clientIdentity.ts`) and used to be forgeable by anyone holding
 * the shared bridge token.
 */
export interface ClientIdentity {
  /** Client name (e.g., "claude-code", "codex-cli", "cursor") */
  name: string;
  /** Client version */
  version?: string;
  /** Process ID */
  pid?: number;
  /** Parent process name (helps identify which AI spawned this) */
  parentProcess?: string;
  /**
   * The user's name for this session, for grouping its edits in VMark.
   * Untrusted, display and grouping only; validated before it is set (see
   * `utils/sessionLabel.ts`). Omitted, not empty, when there is none.
   */
  sessionLabel?: string;
}

/**
 * Function to resolve port dynamically (e.g., read from file).
 */
type PortResolver = () => number | undefined;

/**
 * Configuration for WebSocketBridge.
 */
export interface WebSocketBridgeConfig {
  /** Host to connect to (default: '127.0.0.1' — the IPv4 literal, not 'localhost') */
  host?: string;
  /** Port to connect to (default: auto-discover from app data mcp-port file) */
  port?: number;
  /** Function to resolve port dynamically (called on each connect attempt) */
  portResolver?: PortResolver;
  /** Connection / auth-handshake timeout in ms (default: 10000) */
  timeout?: number;
  /**
   * Pending-request timeout in ms (default: 25000). Must exceed the Rust
   * bridge's worst case of 20s (10s initial wait + 10s wake-and-retry,
   * server.rs) — a shorter value discards retry results that the bridge
   * successfully recovered, so the AI client sees a timeout even though
   * the write WAS applied. A value of 20000 or less is refused (RangeError).
   * Known limitation: the 20s starts once the bridge admits the request; a
   * write-class request first waits, unbounded, for the bridge's global write
   * lock (routed_request.rs), and no client timeout covers that wait.
   */
  requestTimeout?: number;
  /** Whether to auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Base delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number;
  /** Maximum reconnection delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Optional logger for debugging (default: silent) */
  logger?: Logger;
  /** Max requests per second for rate limiting (default: 100, 0 = unlimited) */
  maxRequestsPerSecond?: number;
  /** Queue requests while disconnected if autoReconnect is enabled (default: false) */
  queueWhileDisconnected?: boolean;
  /** Maximum queue size when disconnected (default: 100; a positive integer, else RangeError) */
  maxQueueSize?: number;
  /** Client identity for VMark to identify who is connecting */
  clientIdentity?: ClientIdentity;
  /** Auth token resolver — called on each connect to get the latest token from port file */
  authTokenResolver?: () => string | undefined;
  /**
   * Per-client credential resolver — called on each connect for the token
   * VMark issued to THIS AI client (`VMARK_MCP_TOKEN` in its MCP config).
   *
   * Separate from `authTokenResolver` because the two do different jobs: the
   * auth token decides whether the connection is allowed, this one decides who
   * the connection IS. Returning `undefined` connects normally, unidentified.
   */
  clientTokenResolver?: () => string | undefined;
}

/**
 * `WebSocketBridgeConfig` with every default applied — what the bridge and its
 * collaborators actually read. Immutable: nothing reassigns a field after
 * construction, including `port` (a static port always wins over the resolver).
 */
export interface ResolvedBridgeConfig {
  readonly host: string;
  readonly port: number | undefined;
  readonly portResolver: PortResolver | undefined;
  readonly timeout: number;
  readonly requestTimeout: number;
  readonly autoReconnect: boolean;
  readonly maxReconnectAttempts: number;
  readonly reconnectDelay: number;
  readonly maxReconnectDelay: number;
  readonly logger: Logger;
  readonly maxRequestsPerSecond: number;
  readonly queueWhileDisconnected: boolean;
  readonly maxQueueSize: number;
  readonly clientIdentity: ClientIdentity | null;
  readonly authTokenResolver: (() => string | undefined) | undefined;
  readonly clientTokenResolver: (() => string | undefined) | undefined;
}

/**
 * The Rust bridge's worst case for one ADMITTED request: 10 s initial wait +
 * 10 s wake-and-retry (wake_retry.rs). Time queued for the write lock is extra.
 * Known limitation: 20 s bounds the two window-response waits, not the whole
 * request. A timeout does not cancel a mutation: it may already have succeeded
 * or may succeed later. Re-read before retrying; an immediate re-read does not
 * establish that queued work has finished.
 */
const BRIDGE_WORST_CASE_MS = 20_000;
/** The longest delay `setTimeout` holds; a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The pending-request timeout, refused unless it outlasts the bridge's worst
 * case: a shorter one reports a write the bridge recovered as timed out.
 * @edge-case NaN, Infinity and delays past the timer limit are refused too —
 * `setTimeout` treats them as an immediate timeout.
 */
function requestTimeoutOf(value: number | undefined): number {
  const timeout = value ?? 25000;
  if (!Number.isFinite(timeout) || timeout <= BRIDGE_WORST_CASE_MS || timeout > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `requestTimeout must be more than ${BRIDGE_WORST_CASE_MS} ms (the bridge's wake-and-retry worst case) and at most ${MAX_TIMER_DELAY_MS} ms, got ${timeout}`
    );
  }
  return timeout;
}

/**
 * The disconnected-queue cap, refused unless it is a positive safe integer.
 * @edge-case NaN makes the cap comparison permanently false (an unbounded
 * queue); fractions, zero and negatives are refused rather than clamped.
 */
function maxQueueSizeOf(value: number | undefined): number {
  const size = value ?? 100;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`maxQueueSize must be a positive integer, got ${size}`);
  }
  return size;
}

/**
 * Apply the documented defaults to a caller-supplied config.
 * @throws RangeError when `requestTimeout` cannot outlast the bridge's worst
 * case, or `maxQueueSize` is not a positive integer.
 */
export function resolveBridgeConfig(
  config: WebSocketBridgeConfig = {}
): ResolvedBridgeConfig {
  return {
    host: config.host ?? '127.0.0.1', // Use IPv4 explicitly to avoid IPv6 issues
    port: config.port, // May be undefined - will use portResolver
    portResolver: config.portResolver,
    timeout: config.timeout ?? 10000,
    requestTimeout: requestTimeoutOf(config.requestTimeout),
    autoReconnect: config.autoReconnect ?? true,
    maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    reconnectDelay: config.reconnectDelay ?? 1000,
    maxReconnectDelay: config.maxReconnectDelay ?? 30000,
    logger: config.logger ?? nullLogger,
    maxRequestsPerSecond: config.maxRequestsPerSecond ?? 100,
    queueWhileDisconnected: config.queueWhileDisconnected ?? false,
    maxQueueSize: maxQueueSizeOf(config.maxQueueSize),
    clientIdentity: config.clientIdentity ?? null,
    authTokenResolver: config.authTokenResolver,
    clientTokenResolver: config.clientTokenResolver,
  };
}
