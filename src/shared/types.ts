export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

export type ProviderStatus = 'online' | 'offline' | 'unknown'

export type ProviderType = 'builtin' | 'custom'

// Provider vendor type (for OAuth adapters)
export type ProviderVendor = 'deepseek' | 'glm' | 'kimi' | 'mimo' | 'minimax' | 'qwen' | 'qwen-ai' | 'zai' | 'perplexity' | 'custom'

export type AuthType = 
  | 'oauth' 
  | 'token' 
  | 'cookie' 
  | 'userToken' 
  | 'refresh_token' 
  | 'jwt' 
  | 'realUserID_token' 
  | 'tongyi_sso_ticket'

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  helpText?: string
}

export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover'

export type Theme = 'light' | 'dark' | 'system'

export type {
  LegacyToolPromptConfig,
  ToolCallingConfig,
} from './toolCalling'

export interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  status: AccountStatus
  lastUsed?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}

export interface Provider {
  id: string
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  status?: ProviderStatus
  lastStatusCheck?: number
}

export interface ModelMapping {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ApiKey {
  id: string
  name: string
  key: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  usageCount: number
  description?: string
}

export interface AppConfig {
  proxyPort: number
  proxyHost: string
  loadBalanceStrategy: LoadBalanceStrategy
  modelMappings: Record<string, ModelMapping>
  theme: Theme
  autoStart: boolean
  autoStartProxy: boolean
  minimizeToTray: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays: number
  requestLogConfig: RequestLogConfig
  requestTimeout: number
  retryCount: number
  apiKeys: ApiKey[]
  enableApiKey: boolean
  oauthProxyMode: 'system' | 'none'
  sessionConfig: SessionConfig
  toolCallingConfig: ToolCallingConfig
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi: ManagementApiConfig
  contextManagement?: unknown
  language: 'zh-CN' | 'en-US' | 'ru-RU'
  /** Whether provider model lists are refreshed automatically */
  autoUpdateModels: boolean
  /** Interval between automatic model refreshes, in hours */
  autoUpdateModelsIntervalHours: number
  /** Maximum simultaneous requests a single account may handle (default 1) */
  maxConcurrentPerAccount: number
  /** How long (ms) a request may wait for a free account slot before 429 */
  accountBusyTimeoutMs: number
  /** Delay (seconds) between two consecutive accounts in a batch registration */
  registerIntervalSeconds?: number
  /** Periodically validate all accounts in the background */
  autoCheckAccounts?: boolean
  /** Interval (minutes) between automatic account validations */
  autoCheckAccountsIntervalMinutes?: number
  /** Automatically delete accounts that fail validation */
  autoDeleteBadAccounts?: boolean
  /** Automatically register replacement accounts after bad ones were auto-deleted */
  autoRefillAccounts?: boolean
  /** Target number of accounts per provider (0 = disabled); below it, new accounts are auto-registered */
  targetAccountCount?: number
  /** Temporary mailbox settings for the Qwen AI auto-registration flow */
  tempMail?: TempMailConfig
  /** Geepass captcha-recognition settings used by the captcha window */
  geepass?: GeepassConfig
  /** Upstream proxy settings (manual URL or Clash subscription auto-detect) */
  upstreamProxy?: UpstreamProxyConfig
}

/**
 * Geepass (geepass.cn) captcha-recognition service configuration.
 * Used to solve slide/puzzle captchas inside the in-app captcha window.
 */
export interface GeepassConfig {
  /** Whether Geepass recognition is enabled */
  enabled: boolean
  /** User token from the Geepass console */
  token: string
  /**
   * Recognition type:
   * - 20110: single-image gap detection (background only)
   * - 20111: two-image slider (slider image + background image)
   */
  type: 20110 | 20111
}

/**
 * Upstream proxy configuration for login/captcha windows and outbound
 * axios requests. Either a manually specified proxy URL or automatic
 * detection of a local Clash client, optionally validated against a
 * Clash subscription link.
 */
export interface UpstreamProxyConfig {
  /** Whether the upstream proxy feature is enabled */
  enabled: boolean
  /** Where the proxy comes from:
   *  - manual: user-specified http/socks5 URL
   *  - clash: auto-detect a running local Clash client mixed port
   *  - embedded: dial subscription nodes with the built-in mihomo core */
  source: 'manual' | 'clash' | 'embedded'
  /** Manual proxy URL, e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:7891 */
  manualUrl?: string
  /** Clash subscription URL (informational + node listing) */
  subscriptionUrl?: string
  /** Override for the Clash mixed port (auto-detected when empty) */
  mixedPort?: number
  /** Name of the subscription node the embedded core should dial (empty = subscription default) */
  selectedNode?: string
}

/** A single proxy node parsed from a Clash subscription */
export interface ClashProxyNode {
  name: string
  type: string
  server: string
  port: number
  /** Whether this node type can be dialed directly by the app (http/socks only) */
  usable: boolean
}

/** Result of resolving the effective upstream proxy */
export interface UpstreamProxyInfo {
  /** Whether a usable proxy was found */
  active: boolean
  /** Effective proxy URL (http/https/socks5) */
  url?: string
  /** Human-readable source description */
  source?: string
  /** Error/detail message when inactive */
  message?: string
}

/**
 * Temporary mailbox (Cloudflare Temp Email) configuration
 * used by the Qwen AI auto-registration flow.
 */
export interface TempMailConfig {
  /** API base URL of the Cloudflare Temp Email backend */
  apiUrl: string
  /** Admin authentication password (sent as x-admin-auth header) */
  adminPassword: string
  /** Default mailbox domain used when creating addresses */
  domain: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  message: string
  accountId?: string
  providerId?: string
  requestId?: string
  data?: Record<string, unknown>
}

export interface ProxyStatus {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

export interface ProviderCheckResult {
  providerId: string
  status: ProviderStatus
  latency?: number
  error?: string
}

export interface OAuthResult {
  success: boolean
  providerId?: string
  providerType?: ProviderVendor
  credentials?: Record<string, string>
  account?: Account
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

export interface ValidationResult {
  valid: boolean
  error?: string
  /** True when the failure was a transient connection-level problem (DNS/timeout), not invalid credentials */
  networkError?: boolean
  validatedAt: number
  accountInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
}

export type PromptType = 'general' | 'tool-use' | 'agent' | 'translation' | 'search'

export interface SystemPrompt {
  id: string
  name: string
  description: string
  prompt: string
  type: PromptType
  isBuiltin: boolean
  emoji?: string
  groups?: string[]
  createdAt: number
  updatedAt: number
}

export interface SessionConfig {
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

export interface RequestLogConfig {
  enabled: boolean
  maxEntries: number
  includeBodies: boolean
  maxBodyChars: number
  redactSensitiveData: boolean
}

export interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export interface ManagementApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ManagementApiError
}

export interface ManagementApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ManagementApiPaginationParams {
  page?: number
  limit?: number
}

export interface ManagementApiPaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateProviderRequest {
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface UpdateProviderRequest {
  name?: string
  apiEndpoint?: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface ProviderStatusRequest {
  enabled: boolean
}

export interface CreateAccountRequest {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

export interface UpdateAccountRequest {
  name?: string
  email?: string
  credentials?: Record<string, string>
  dailyLimit?: number
}

export interface CreateApiKeyRequest {
  name: string
  description?: string
}

export interface UpdateApiKeyRequest {
  name?: string
  description?: string
  enabled?: boolean
}

export interface CreateModelMappingRequest {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface UpdateModelMappingRequest {
  actualModel?: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ProxyStatusResponse {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded'
  version: string
  uptime: number
  timestamp: number
  components?: {
    proxy: 'up' | 'down'
    database: 'up' | 'down'
    managementApi: 'up' | 'down'
  }
}

export interface StatisticsResponse {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats?: Record<string, {
    totalRequests: number
    successRequests: number
    failedRequests: number
  }>
}

export interface ConfigUpdateRequest {
  proxyPort?: number
  proxyHost?: string
  loadBalanceStrategy?: LoadBalanceStrategy
  theme?: Theme
  autoStart?: boolean
  autoStartProxy?: boolean
  minimizeToTray?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays?: number
  requestLogConfig?: Partial<RequestLogConfig>
  requestTimeout?: number
  retryCount?: number
  enableApiKey?: boolean
  oauthProxyMode?: 'system' | 'none'
  sessionConfig?: SessionConfig
  toolCallingConfig?: Partial<ToolCallingConfig>
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi?: ManagementApiConfig
}

export interface EffectiveModel {
  displayName: string
  actualModelId: string
  isCustom: boolean
}
