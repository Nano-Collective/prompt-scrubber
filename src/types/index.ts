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
  options?: ScrubOptions;
}

export interface ScrubOptions {
  customDetectors?: Detector[];
  disabledDetectors?: string[]; // Array of detector names to skip
}

export interface ScrubResult {
  scrubbedContent: string | Message[];
  sessionId: string;
}

export interface RehydrateRequest {
  content: string;
  sessionId: string;
}

export interface RehydrateResult {
  content: string;
  warnings?: string[]; // Populated if the model invents a placeholder not in the session map
}
