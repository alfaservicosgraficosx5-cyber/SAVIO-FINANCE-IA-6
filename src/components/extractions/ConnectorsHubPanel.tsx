import React from 'react';
import type { Account, CreditCard } from '../../types';
import type {
  ConnectorStatus,
  ExtractionBatch,
  FinancialConnectorState,
} from '../../types-sub/extractions';
import type { ConnectorHealthSummary } from '../../domain/extractions/connectors/connectorTypes';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard as CreditCardIcon,
  FileSpreadsheet,
  KeyRound,
  Mail,
  Power,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';

interface ConnectorsHubPanelProps {
  connectorStates: FinancialConnectorState[];
  healthSummary: ConnectorHealthSummary;
  batches: ExtractionBatch[];
  accounts: Account[];
  creditCards: CreditCard[];
  onToggleConnector: (connectorId: string) => void;
  onToggleOpenFinanceAuth: (authorized: boolean) => void;
  onGoToImport: () => void;
  onGoToGmail: () => void;
  onNavigateCards?: () => void;
}

const CONNECTOR_STATUS_META: Record<
  ConnectorStatus,
  { label: string; className: string }
> = {
  DISPONIVEL: {
    label: 'Disponível',
    className:
      'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
  },
  CONFIGURADO: {
    label: 'Configurado',
    className:
      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-800',
  },
  AGUARDANDO_AUTORIZACAO: {
    label: 'Aguardando autorização',
    className:
      'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/70 dark:text-amber-300 dark:border-amber-800',
  },
  IMPORTACAO_MANUAL: {
    label: 'Importação manual',
    className:
      'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/70 dark:text-sky-300 dark:border-sky-800',
  },
  ERRO_CONEXAO: {
    label: 'Erro de conexão',
    className:
      'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/70 dark:text-red-300 dark:border-red-800',
  },
  FONTE_NAO_SUPORTADA: {
    label: 'Fonte não suportada',
    className:
      'bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700',
  },
  DESATIVADO: {
    label: 'Desativado',
    className:
      'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-900 dark:text-slate-500 dark:border-slate-800',
  },
};

export const ConnectorsHubPanel: React.FC<ConnectorsHubPanelProps> = ({
  connectorStates,
  healthSummary,
  batches,
  accounts,
  creditCards,
  onToggleConnector,
  onToggleOpenFinanceAuth,
  onGoToImport,
  onGoToGmail,
  onNavigateCards,
}) => {
  const activeAccountsCount = accounts.filter((a) => !a.archived).length;

  return (
    <div className="space-y-5">
      {/* Health Summary Strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="sf-card p-3.5">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Fontes / Conectores
          </span>
          <strong className="font-money block text-lg font-extrabold text-[#0F172A] dark:text-white mt-0.5">
            {healthSummary.totalConnectors}
          </strong>
          <small className="text-[11px] text-[#64748B] dark:text-slate-400">
            {healthSummary.configuredCount} ativo(s) ou prontos
          </small>
        </div>

        <div className="sf-card p-3.5">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Aguardando autorização
          </span>
          <strong className="font-money block text-lg font-extrabold text-amber-700 dark:text-amber-300 mt-0.5">
            {healthSummary.awaitingAuthCount}
          </strong>
          <small className="text-[11px] text-[#64748B] dark:text-slate-400">
            Requer consentimento explícito
          </small>
        </div>

        <div className="sf-card p-3.5">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Contas &amp; Cartões ativos
          </span>
          <strong className="font-money block text-lg font-extrabold text-[#059669] dark:text-[#10B981] mt-0.5">
            {activeAccountsCount + creditCards.length}
          </strong>
          <small className="text-[11px] text-[#64748B] dark:text-slate-400">
            {activeAccountsCount} conta(s) · {creditCards.length} cartão(ões)
          </small>
        </div>

        <div className="sf-card p-3.5">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Última sincronização
          </span>
          <strong className="block text-sm font-extrabold text-[#0F172A] dark:text-white mt-1 truncate">
            {healthSummary.lastSyncAt
              ? new Date(healthSummary.lastSyncAt).toLocaleString('pt-BR')
              : 'Nenhuma ainda'}
          </strong>
          <small className="text-[11px] text-[#64748B] dark:text-slate-400">
            {batches.length} lote(s) no histórico
          </small>
        </div>
      </section>

      {/* Security Guardrail Notice */}
      <div className="p-3.5 rounded-2xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-900 dark:text-emerald-200 flex items-start gap-2.5">
        <ShieldCheck size={18} className="shrink-0 mt-0.5" />
        <div>
          <strong className="block font-bold">
            Arquitetura segura sem senhas bancárias e sem scraping
          </strong>
          <span>
            Todos os conectores utilizam arquivos exportados oficialmente pelo banco, OAuth 2.0 oficial do Google Workspace ou contrato preparado para Open Finance com consentimento explícito — nenhuma senha ou credencial bancária é coletada ou armazenada.
          </span>
        </div>
      </div>

      {/* Connectors Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {connectorStates.map((conn) => {
          const meta = CONNECTOR_STATUS_META[conn.status] || CONNECTOR_STATUS_META.DISPONIVEL;
          const isDisabled = conn.status === 'DESATIVADO';
          const Icon =
            conn.kind === 'CARD_INVOICE'
              ? CreditCardIcon
              : conn.kind === 'GOOGLE_WORKSPACE'
                ? Mail
                : conn.kind === 'OPEN_FINANCE_CONTRACT'
                  ? KeyRound
                  : FileSpreadsheet;

          return (
            <article
              key={conn.id}
              className="sf-card p-4 sm:p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#061E3E] dark:bg-white/10 text-white grid place-items-center shrink-0">
                      <Icon size={18} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-display text-sm sm:text-base font-bold text-[#0F172A] dark:text-white leading-snug">
                        {conn.name}
                      </h3>
                      <p className="text-[11px] text-[#64748B] dark:text-slate-400 mt-0.5">
                        {conn.acquisitionMethod}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase shrink-0 ${meta.className}`}
                  >
                    {meta.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {conn.supportedFormats.map((fmt) => (
                    <span
                      key={fmt}
                      className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/10 text-[10px] font-mono font-bold text-[#0F172A] dark:text-slate-200"
                    >
                      {fmt}
                    </span>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-slate-50 dark:bg-white/5 rounded-xl p-2.5 border border-slate-200/70 dark:border-white/10">
                  <div>
                    <span className="block text-[10px] text-slate-400">Última sincronização</span>
                    <strong className="text-[#0F172A] dark:text-white">
                      {conn.lastSyncAt
                        ? new Date(conn.lastSyncAt).toLocaleString('pt-BR')
                        : 'Aguardando importação'}
                    </strong>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Período coberto</span>
                    <strong className="text-[#0F172A] dark:text-white">
                      {conn.coveredPeriodStart && conn.coveredPeriodEnd
                        ? `${conn.coveredPeriodStart} até ${conn.coveredPeriodEnd}`
                        : conn.coveredPeriodStart || 'Sem período registrado'}
                    </strong>
                  </div>
                </div>

                {conn.lastError && (
                  <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-[11px] text-red-700 dark:text-red-300 flex items-start gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{conn.lastError}</span>
                  </div>
                )}

                {conn.limitations.length > 0 && (
                  <ul className="text-[11px] text-[#64748B] dark:text-slate-400 space-y-1 list-disc pl-4">
                    {conn.limitations.map((lim, i) => (
                      <li key={i}>{lim}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  {conn.kind === 'FILE_UPLOAD' && !isDisabled && (
                    <button
                      type="button"
                      onClick={onGoToImport}
                      className="min-h-9 px-3 rounded-xl bg-[#061E3E] dark:bg-[#059669] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Upload size={13} /> Importar arquivo
                    </button>
                  )}

                  {conn.kind === 'CARD_INVOICE' && !isDisabled && (
                    <button
                      type="button"
                      onClick={onNavigateCards || onGoToImport}
                      className="min-h-9 px-3 rounded-xl bg-[#061E3E] dark:bg-[#059669] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <CreditCardIcon size={13} /> {onNavigateCards ? 'Ir para Cartões' : 'Importar fatura'}
                    </button>
                  )}

                  {conn.kind === 'GOOGLE_WORKSPACE' && !isDisabled && (
                    <button
                      type="button"
                      onClick={onGoToGmail}
                      className="min-h-9 px-3 rounded-xl bg-[#061E3E] dark:bg-[#059669] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Mail size={13} /> Gerenciar Gmail &amp; OAuth
                    </button>
                  )}

                  {conn.kind === 'OPEN_FINANCE_CONTRACT' && !isDisabled && (
                    <button
                      type="button"
                      onClick={() => onToggleOpenFinanceAuth(!conn.userAuthorized)}
                      className={`min-h-9 px-3 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                        conn.userAuthorized
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700'
                          : 'bg-[#061E3E] text-white'
                      }`}
                    >
                      {conn.userAuthorized ? (
                        <>
                          <CheckCircle2 size={13} /> Consentimento pré-autorizado (Revogar)
                        </>
                      ) : (
                        <>
                          <RefreshCw size={13} /> Registrar pré-autorização
                        </>
                      )}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onToggleConnector(conn.id)}
                  className="min-h-9 px-3 rounded-xl border border-slate-200 dark:border-white/15 text-xs font-semibold text-slate-600 dark:text-slate-300 inline-flex items-center gap-1.5 hover:bg-slate-100 dark:hover:bg-white/10 cursor-pointer"
                >
                  <Power size={13} />
                  {isDisabled ? 'Reativar' : 'Desativar'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};
