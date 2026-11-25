import type {
  ConnectorKind,
  ConnectorStatus,
  ExtractionBatch,
  ExtractionFileFormat,
  FinancialConnectorState,
  ParseResultPayload,
} from '../../../types-sub/extractions';

export interface ConnectorRunContext {
  file?: File;
  buffer?: ArrayBuffer;
  fileName?: string;
}

export interface ConnectorRunResult {
  connectorId: string;
  ok: boolean;
  parseResult?: ParseResultPayload;
  errors: string[];
  limitations: string[];
  acquisitionMethod: string;
  coveredPeriodStart?: string;
  coveredPeriodEnd?: string;
}

export interface FinancialConnectorAdapter {
  id: string;
  name: string;
  kind: ConnectorKind;
  defaultStatus: ConnectorStatus;
  acquisitionMethod: string;
  supportedFormats: string[];
  limitations: string[];
  requiresExplicitAuthorization: boolean;
  supportsFormat?: (format: ExtractionFileFormat) => boolean;
  validateInput?: (ctx: ConnectorRunContext) => { ok: boolean; error?: string };
  computeCoveredPeriod?: (batches: ExtractionBatch[]) => { start?: string; end?: string };
}

export interface ConnectorHealthSummary {
  totalConnectors: number;
  configuredCount: number;
  awaitingAuthCount: number;
  errorCount: number;
  lastSyncAt?: string;
}
