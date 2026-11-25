import type { FinancialConnectorAdapter } from './connectorTypes';
import { validateExtractionUploadFile } from '../fileSecurity';

export const LOCAL_FILE_STATEMENT_CONNECTOR: FinancialConnectorAdapter = {
  id: 'conn-local-statement-files',
  name: 'Importação Manual de Extratos (OFX, CSV, XLSX, PDF, XML, JSON)',
  kind: 'FILE_UPLOAD',
  defaultStatus: 'IMPORTACAO_MANUAL',
  acquisitionMethod: 'Parser local isolado + OCR autorizado opcional',
  supportedFormats: ['OFX', 'CSV', 'XLSX', 'XLS', 'PDF', 'XML', 'JSON', 'IMAGE'],
  limitations: [
    'PDFs digitalizados sem camada textual exigem autorização explícita de OCR.',
    'Limite seguro de até 15 MB e 50 páginas por arquivo PDF.',
  ],
  requiresExplicitAuthorization: false,
  supportsFormat: (fmt) =>
    ['OFX', 'CSV', 'XLSX', 'XLS', 'PDF', 'XML', 'JSON', 'IMAGE'].includes(fmt),
  validateInput: (ctx) => {
    if (!ctx.file) {
      return { ok: false, error: 'Nenhum arquivo selecionado.' };
    }
    return validateExtractionUploadFile(ctx.file);
  },
  computeCoveredPeriod: (batches) => {
    const valid = batches.filter((b) => b.status !== 'CANCELADO' && b.connectorId !== 'conn-card-invoice');
    const starts = valid.map((b) => b.periodStart).filter(Boolean).sort() as string[];
    const ends = valid.map((b) => b.periodEnd).filter(Boolean).sort() as string[];
    return {
      start: starts[0],
      end: ends[ends.length - 1],
    };
  },
};
