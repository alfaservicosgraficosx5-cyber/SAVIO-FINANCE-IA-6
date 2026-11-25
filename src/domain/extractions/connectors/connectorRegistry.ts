import type { Account, CreditCard } from '../../../types';
import type {
  ExtractionBatch,
  FinancialConnectorState,
} from '../../../types-sub/extractions';
import { LOCAL_FILE_STATEMENT_CONNECTOR } from './localFileConnector';
import { CARD_INVOICE_CONNECTOR } from './cardInvoiceConnector';
import { GOOGLE_WORKSPACE_STATEMENTS_CONNECTOR } from './googleWorkspaceConnector';
import { OPEN_FINANCE_CONTRACT_CONNECTOR } from './openFinanceContract';
import type {
  ConnectorHealthSummary,
  FinancialConnectorAdapter,
} from './connectorTypes';

export const BUILTIN_CONNECTOR_ADAPTERS: FinancialConnectorAdapter[] = [
  LOCAL_FILE_STATEMENT_CONNECTOR,
  CARD_INVOICE_CONNECTOR,
  GOOGLE_WORKSPACE_STATEMENTS_CONNECTOR,
  OPEN_FINANCE_CONTRACT_CONNECTOR,
];

export function buildMergedConnectorStates(params: {
  persistedStates: FinancialConnectorState[];
  batches: ExtractionBatch[];
  accounts: Account[];
  creditCards: CreditCard[];
  workspaceTokenPresent?: boolean;
}): FinancialConnectorState[] {
  const { persistedStates, batches, accounts, creditCards, workspaceTokenPresent } = params;
  const nowIso = new Date().toISOString();
  const byId = new Map(persistedStates.map((s) => [s.id, s]));

  const nonCancelled = batches.filter((b) => b.status !== 'CANCELADO');
  const activeAccs = accounts.filter((a) => !a.archived);

  return BUILTIN_CONNECTOR_ADAPTERS.map((adapter) => {
    const prev = byId.get(adapter.id);
    const matchingBatches = nonCancelled.filter((b) => {
      if (adapter.id === 'conn-card-invoice') {
        return Boolean(b.confirmedCardId || b.identifiedAccount.matchedCardId || b.connectorId === adapter.id);
      }
      if (adapter.id === 'conn-local-statement-files') {
        return !b.confirmedCardId && !b.identifiedAccount.matchedCardId;
      }
      return b.connectorId === adapter.id;
    });

    const latestBatch = [...matchingBatches].sort((a, b) =>
      b.importedAt.localeCompare(a.importedAt)
    )[0];
    const starts = matchingBatches.map((b) => b.periodStart).filter(Boolean).sort() as string[];
    const ends = matchingBatches.map((b) => b.periodEnd).filter(Boolean).sort() as string[];

    let resolvedStatus = prev?.status || adapter.defaultStatus;
    let userAuthorized = prev?.userAuthorized ?? !adapter.requiresExplicitAuthorization;

    if (prev?.status === 'DESATIVADO') {
      resolvedStatus = 'DESATIVADO';
    } else if (adapter.id === 'conn-google-workspace') {
      userAuthorized = Boolean(workspaceTokenPresent || prev?.userAuthorized);
      resolvedStatus = userAuthorized ? 'CONFIGURADO' : 'AGUARDANDO_AUTORIZACAO';
    } else if (adapter.id === 'conn-open-finance-br') {
      resolvedStatus = prev?.userAuthorized ? 'CONFIGURADO' : 'AGUARDANDO_AUTORIZACAO';
    } else if (adapter.id === 'conn-local-statement-files') {
      resolvedStatus =
        matchingBatches.length > 0
          ? latestBatch?.status === 'ERRO'
            ? 'ERRO_CONEXAO'
            : 'CONFIGURADO'
          : activeAccs.length > 0
            ? 'IMPORTACAO_MANUAL'
            : 'DISPONIVEL';
    } else if (adapter.id === 'conn-card-invoice') {
      resolvedStatus = creditCards.length > 0 ? 'CONFIGURADO' : 'DISPONIVEL';
    }

    return {
      id: adapter.id,
      name: adapter.name,
      kind: adapter.kind,
      status: resolvedStatus,
      acquisitionMethod: adapter.acquisitionMethod,
      supportedFormats: adapter.supportedFormats,
      accountId: prev?.accountId,
      institutionId: prev?.institutionId,
      lastSyncAt: latestBatch?.importedAt || prev?.lastSyncAt,
      coveredPeriodStart: starts[0] || prev?.coveredPeriodStart,
      coveredPeriodEnd: ends[ends.length - 1] || prev?.coveredPeriodEnd,
      userAuthorized,
      lastError: latestBatch?.status === 'ERRO' ? latestBatch.errors[0] : prev?.lastError,
      limitations: adapter.limitations,
      updatedAt: prev?.updatedAt || nowIso,
    };
  });
}

export function recordConnectorSyncFromBatch(
  states: FinancialConnectorState[],
  batch: ExtractionBatch
): FinancialConnectorState[] {
  const nowIso = new Date().toISOString();
  const targetId =
    batch.connectorId ||
    (batch.confirmedCardId || batch.identifiedAccount.matchedCardId
      ? 'conn-card-invoice'
      : 'conn-local-statement-files');

  return states.map((s) => {
    if (s.id !== targetId) return s;
    return {
      ...s,
      lastSyncAt: batch.importedAt || nowIso,
      coveredPeriodStart:
        !s.coveredPeriodStart || (batch.periodStart && batch.periodStart < s.coveredPeriodStart)
          ? batch.periodStart
          : s.coveredPeriodStart,
      coveredPeriodEnd:
        !s.coveredPeriodEnd || (batch.periodEnd && batch.periodEnd > s.coveredPeriodEnd)
          ? batch.periodEnd
          : s.coveredPeriodEnd,
      status: batch.status === 'ERRO' ? 'ERRO_CONEXAO' : 'CONFIGURADO',
      lastError: batch.status === 'ERRO' ? batch.errors[0] : undefined,
      updatedAt: nowIso,
    };
  });
}

export function authorizeOpenFinanceConnector(
  states: FinancialConnectorState[],
  authorized: boolean
): FinancialConnectorState[] {
  const nowIso = new Date().toISOString();
  return states.map((s) =>
    s.id === 'conn-open-finance-br'
      ? {
          ...s,
          userAuthorized: authorized,
          status: s.status === 'DESATIVADO' ? 'DESATIVADO' : authorized ? 'CONFIGURADO' : 'AGUARDANDO_AUTORIZACAO',
          updatedAt: nowIso,
        }
      : s
  );
}

export function toggleConnectorEnabled(
  states: FinancialConnectorState[],
  connectorId: string
): FinancialConnectorState[] {
  const nowIso = new Date().toISOString();
  return states.map((s) => {
    if (s.id !== connectorId) return s;
    const isDisabled = s.status === 'DESATIVADO';
    const adapter = BUILTIN_CONNECTOR_ADAPTERS.find((a) => a.id === connectorId);
    const restoredStatus =
      adapter?.requiresExplicitAuthorization && !s.userAuthorized
        ? 'AGUARDANDO_AUTORIZACAO'
        : adapter?.defaultStatus || 'DISPONIVEL';
    return {
      ...s,
      status: isDisabled ? restoredStatus : 'DESATIVADO',
      updatedAt: nowIso,
    };
  });
}

export function computeConnectorHealthSummary(
  states: FinancialConnectorState[]
): ConnectorHealthSummary {
  const syncDates = states.map((s) => s.lastSyncAt).filter(Boolean).sort() as string[];
  return {
    totalConnectors: states.length,
    configuredCount: states.filter(
      (s) => s.status === 'CONFIGURADO' || s.status === 'IMPORTACAO_MANUAL' || s.status === 'DISPONIVEL'
    ).length,
    awaitingAuthCount: states.filter((s) => s.status === 'AGUARDANDO_AUTORIZACAO').length,
    errorCount: states.filter((s) => s.status === 'ERRO_CONEXAO').length,
    lastSyncAt: syncDates[syncDates.length - 1],
  };
}
