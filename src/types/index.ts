// Shared Types

export interface Finding {
  category: string;
  span: [number, number];
  value: string;
  placeholderPrefix: string;
  // How certain the detector is about this match, from 0.0 to 1.0. Optional so
  // detectors written against the original interface (published rule packs)
  // keep compiling; the pipeline scores those as DEFAULT_CONFIDENCE.
  confidence?: number;
  // How the match was made: 'exact-pattern', 'structural', 'key-name',
  // 'entropy', 'heuristic', 'user-defined', or a rule pack's own label.
  method?: string;
}

// A Finding once the pipeline has filled in the optional scoring fields.
export type ScoredFinding = Finding & { confidence: number; method: string };

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
  minConfidence?: number; // Discard findings scored below this threshold (0.0-1.0, default 0)
}

// Findings a `minConfidence` threshold discarded and which no surviving
// finding covers — i.e. what the threshold actually left in the clear.
export interface SuppressedStats {
  total: number;
  byCategory: Record<string, number>;
}

export interface ScrubStats {
  totalEntities: number;
  byCategory: Record<string, number>;
  // Present only when a threshold actually dropped something. Reported so a
  // caller can tell "there was no phone number" apart from "there was one and
  // I filtered it out" — for a redaction tool, silent under-redaction is the
  // dangerous direction.
  suppressed?: SuppressedStats;
}

export interface ScrubResult {
  scrubbedContent: string | Message[];
  sessionId?: string;
  sessionMap?: Record<string, string>;
  stats: ScrubStats;
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
