import type { FinancialConnectorAdapter } from './connectorTypes';
import { validateExtractionUploadFile } from '../fileSecurity';

export const CARD_INVOICE_CONNECTOR: FinancialConnectorAdapter = {
  id: 'conn-card-invoice',
  name: 'Auditor de Faturas de Cartão de Crédito',
  kind: 'CARD_INVOICE',
  defaultStatus: 'DISPONIVEL',
  acquisitionMethod: 'Leitura estruturada de faturas + Auditoria de parcelamentos',
  supportedFormats: ['PDF', 'CSV', 'XLSX', 'XLS', 'IMAGE'],
  limitations: [
    'Pagamentos anteriores e limites disponíveis são separados para evitar dupla contagem.',
    'Parcelas futuras só são projetadas após verificação de sobreposição.',
  ],
  requiresExplicitAuthorization: false,
  supportsFormat: (fmt) => ['PDF', 'CSV', 'XLSX', 'XLS', 'IMAGE'].includes(fmt),
  validateInput: (ctx) => {
    if (!ctx.file) return { ok: false, error: 'Arquivo de fatura não selecionado.' };
    return validateExtractionUploadFile(ctx.file);
  },
  computeCoveredPeriod: (batches) => {
    const valid = batches.filter((b) => b.status !== 'CANCELADO' && Boolean(b.confirmedCardId));
    const starts = valid.map((b) => b.periodStart).filter(Boolean).sort() as string[];
    const ends = valid.map((b) => b.periodEnd).filter(Boolean).sort() as string[];
    return {
      start: starts[0],
      end: ends[ends.length - 1],
    };
  },
};
