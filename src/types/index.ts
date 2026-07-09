// Shared Types

export interface Finding {
  category: string;
  span: [number, number];
  value: string;
  placeholderPrefix: string;
}

export interface Detector {
  name: string;
  detect(text: string): Finding[];
}

export interface SessionMap {
  [placeholder: string]: string;
}

export interface Message {
  role: string;
  content: string;
}

export interface ScrubRequest {
  content: string | Message[];
  sessionId?: string;
  sessionMap?: Record<string, string>;
  options?: ScrubOptions;
}

export interface ScrubOptions {
  customDetectors?: Detector[];
  disabledDetectors?: string[]; // Array of detector names to skip
  enabledDetectors?: string[]; // Array of off-by-default detector names to enable
  strictNameDetector?: boolean; // Enable stricter allowlisting for the NameDetector
  codeTellTerms?: string[]; // User-enumerated private identifiers (classes, variables)
  urlAllowlist?: string[]; // List of hostnames to pass-through in URLs
}

export interface ScrubResult {
  scrubbedContent: string | Message[];
  sessionId?: string;
  sessionMap?: Record<string, string>;
}

export interface RehydrateRequest {
  content: string | Message[];
  sessionId?: string;
  sessionMap?: Record<string, string>;
}

export interface RehydrateResult {
  content: string | Message[];
  warnings?: string[]; // Populated if the model invents a placeholder not in the session map
}
