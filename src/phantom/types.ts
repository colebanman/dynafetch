export interface ScriptAsset {
  id: string;
  type: 'inline' | 'external';
  scriptKind: 'classic' | 'module';
  category: 'application' | 'telemetry' | 'ads' | 'chat' | 'widget' | 'bot-defense' | 'unknown';
  content: string; // The actual JS code
  url?: string; // Original URL if external
  order: number;
  execution: 'sync' | 'defer' | 'async';
}

export interface HarvestResult {
  url: string;
  status: number;
  html: string;
  scripts: ScriptAsset[];
  modulePreloads: Array<{ url: string; content: string }>;
  skippedScriptCount: number;
  initialState: Record<string, any>; // Extracted JSON blobs
  cookies: string[]; // Set-Cookie headers
  headers: Record<string, string>; // Initial response headers
  logs: NetworkLogEntry[];
  moduleGraphCache?: Map<string, string>; // Pre-warmed module source cache
}

export interface NetworkLogEntry {
  type: 'fetch' | 'xhr' | 'websocket' | 'eventsource' | 'dynamic_import' | 'resource_load';
  method?: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  timestamp: number;
  initiator?: string; // Stack trace or script ID
}

export interface ExecutionError {
  source: 'error' | 'unhandledrejection' | 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
}

export interface ExecutionResult {
  logs: NetworkLogEntry[];
  matchedRequests: NetworkLogEntry[];
  renderedHtml?: string;
  timings?: {
    transform_ms_total: number;
    scripts_transformed_count: number;
    quiescence_ms: number;
  };
  errors?: ExecutionError[];
}
