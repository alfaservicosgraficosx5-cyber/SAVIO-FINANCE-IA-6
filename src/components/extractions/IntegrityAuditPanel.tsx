import React from 'react';
import type {
  AuditFinding,
  DuplicateUserDecision,
  ExtractionBatch,
} from '../../types-sub/extractions';
import { fromCents } from '../../domain/money/money';
import { formatarValor } from '../../utils/formatters';
import { usePrivacy } from '../../contexts/PrivacyContext';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';

interface IntegrityAuditPanelProps {
  batch: ExtractionBatch | null;
  onApplyDecision: (params: {
    movementId?: string;
    findingId?: string;
    decision: DuplicateUserDecision;
    note?: string;
  }) => void;
  onOpenMovementEdit: (movementId: string) => void;
  onReprocessBatch?: () => void;
  onGoToReview: () => void;
  onGoToImport: () => void;
}

const LIFECYCLE_LABELS: Record<string, string> = {
  UPLOADED: 'Enviado',
  PROCESSING: 'Processando',
  EXTRACTED: 'Extraído',
  AUDITING: 'Em auditoria',
  READY_FOR_REVIEW: 'Pronto para revisão',
  APPROVED: 'Aprovado',
  APPROVED_WITH_WARNINGS: 'Aprovado com alertas',
  BLOCKED: 'Bloqueado (pendência crítica)',
  FAILED: 'Falha na leitura',
  INTEGRATED: 'Integrado',
};

function renderSeverityBadge(severity: AuditFinding['severity']) {
  if (severity === 'CRITICAL') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-100 text-red-800 dark:bg-red-950/70 dark:text-red-300 border border-red-200 dark:border-red-800 text-[10px] font-bold uppercase">
        <AlertCircle size={11} /> Crítica
      </span>
    );
  }
  if (severity === 'WARNING') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-[10px] font-bold uppercase">
        <AlertTriangle size={11} /> Alerta
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300 border border-sky-200 dark:border-sky-800 text-[10px] font-bold uppercase">
      <Info size={11} /> Informativo
    </span>
  );
}

export const IntegrityAuditPanel: React.FC<IntegrityAuditPanelProps> = ({
  batch,
  onApplyDecision,
  onOpenMovementEdit,
  onReprocessBatch,
  onGoToReview,
  onGoToImport,
}) => {
  const { hideValues } = usePrivacy();

  if (!batch) {
    return (
      <div className="sf-card p-8 text-center space-y-3">
        <ShieldCheck size={32} className="mx-auto text-slate-400" />
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          Nenhum lote selecionado para exibir a auditoria matemática e de integridade.
        </p>
        <button
          type="button"
          onClick={onGoToImport}
          className="min-h-10 px-4 rounded-xl bg-[#061E3E] dark:bg-[#059669] text-white text-xs font-bold cursor-pointer"
        >
          Importar extrato
        </button>
      </div>
    );
  }

  const audit = batch.integrityAudit;
  const inc = batch.incrementalSummary;
  const findings = audit?.findings || [];
  const unresolvedCriticalCount = findings.filter(
    (f) => f.severity === 'CRITICAL' && !f.resolvedAction
  ).length;
  const unresolvedWarningCount = findings.filter(
    (f) => f.severity === 'WARNING' && !f.resolvedAction
  ).length;

  return (
    <div className="space-y-5">
      {/* Batch Lifecycle & Reimport Banner */}
      <div className="sf-card p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-sm sm:text-base font-extrabold text-[#0F172A] dark:text-white">
                Auditoria de Integridade · {batch.fileName}
              </h3>
              {batch.auditLifecycleStatus && (
                <span className="px-2.5 py-0.5 rounded-md bg-slate-100 dark:bg-white/10 text-[10px] font-bold uppercase text-[#0F172A] dark:text-slate-200">
                  {LIFECYCLE_LABELS[batch.auditLifecycleStatus] || batch.auditLifecycleStatus}
                </span>
              )}
              {audit?.blocked && (
                <span className="px-2.5 py-0.5 rounded-md bg-red-100 text-red-800 dark:bg-red-950/70 dark:text-red-300 text-[10px] font-bold uppercase">
                  Bloqueado até revisão
                </span>
              )}
            </div>
            <p className="text-xs text-[#64748B] dark:text-slate-400 mt-0.5">
              Parser: <span className="font-mono">{batch.parserVersion || 'padrão'}</span> ·{' '}
              Método: <span className="font-mono">{batch.extractionMethod || batch.parseSource}</span> ·{' '}
              Auditado em{' '}
              {audit?.auditedAt
                ? new Date(audit.auditedAt).toLocaleString('pt-BR')
                : new Date(batch.importedAt).toLocaleString('pt-BR')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onReprocessBatch && (
              <button
                type="button"
                onClick={onReprocessBatch}
                className="min-h-9 px-3 rounded-xl border border-slate-200 dark:border-white/15 text-xs font-bold text-[#0F172A] dark:text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw size={13} /> Reprocessar lote
              </button>
            )}
            <button
              type="button"
              onClick={onGoToReview}
              className="min-h-9 px-3 rounded-xl bg-[#061E3E] dark:bg-[#059669] text-white text-xs font-bold cursor-pointer"
            >
              Ir para Revisão
            </button>
          </div>
        </div>

        {batch.reimportOfBatchId && (
          <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <ShieldAlert size={16} className="shrink-0 mt-0.5" />
            <div>
              <strong>Arquivo já importado anteriormente (Lote {batch.reimportOfBatchId}):</strong>{' '}
              reimportação idempotente — itens idênticos foram marcados como existentes e não serão duplicados no ledger oficial.
            </div>
          </div>
        )}

        {/* Phase 1 Incremental Sync Summary */}
        {inc && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-2">
            {[
              { label: 'Analisados', value: inc.totalAnalyzed, tone: 'text-[#0F172A] dark:text-white' },
              { label: 'Novos', value: inc.newCount, tone: 'text-[#059669] dark:text-[#10B981]' },
              { label: 'Existentes', value: inc.existingCount, tone: 'text-slate-600 dark:text-slate-300' },
              { label: 'Atualiz. origem', value: inc.updatedSourceCount, tone: 'text-sky-700 dark:text-sky-300' },
              { label: 'Poss. duplic.', value: inc.possibleDuplicateCount, tone: 'text-amber-700 dark:text-amber-300' },
              { label: 'Revisão', value: inc.needsReviewCount, tone: 'text-purple-700 dark:text-purple-300' },
              { label: 'Inválidos', value: inc.invalidCount, tone: 'text-red-700 dark:text-red-400' },
            ].map((k) => (
              <div
                key={k.label}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/70 dark:border-white/10"
              >
                <span className="block text-[10px] font-semibold text-slate-400 uppercase truncate">
                  {k.label}
                </span>
                <strong className={`font-money block text-base font-extrabold tabular-nums ${k.tone}`}>
                  {k.value}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Phase 3 Checklist (6.1 + 6.2) */}
      {audit && (
        <section className="sf-card p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-[#0F172A] dark:text-white flex items-center gap-2">
              <ClipboardList size={16} className="text-[#059669]" />
              Checklist de Integridade do Lote ({audit.checklist.filter((c) => c.passed).length}/
              {audit.checklist.length})
            </h4>
            <span
              className={`text-xs font-bold ${
                unresolvedCriticalCount > 0
                  ? 'text-red-700 dark:text-red-400'
                  : unresolvedWarningCount > 0
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-[#059669] dark:text-[#10B981]'
              }`}
            >
              {unresolvedCriticalCount > 0
                ? `${unresolvedCriticalCount} pendência(s) crítica(s)`
                : unresolvedWarningCount > 0
                  ? `${unresolvedWarningCount} alerta(s) pendente(s)`
                  : 'Auditoria limpa'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {audit.checklist.map((item) => (
              <div
                key={item.code}
                className={`p-2.5 rounded-xl border text-xs flex items-start gap-2 ${
                  item.passed
                    ? 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200/80 dark:border-emerald-900'
                    : 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/80 dark:border-amber-900'
                }`}
              >
                {item.passed ? (
                  <CheckCircle2 size={15} className="text-[#059669] shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle size={15} className="text-amber-600 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <strong className="block font-semibold text-[#0F172A] dark:text-white">
                    {item.label}
                  </strong>
                  {item.detail && (
                    <span className="text-[10px] text-[#64748B] dark:text-slate-400">
                      {item.detail}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Structured Findings */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-[#0F172A] dark:text-white">
            Achados &amp; Divergências ({findings.length})
          </h4>
        </div>

        {findings.length === 0 ? (
          <div className="sf-card p-6 text-center text-xs sm:text-sm text-emerald-700 dark:text-emerald-300 font-semibold flex items-center justify-center gap-2">
            <CheckCircle2 size={18} />
            Nenhuma divergência, duplicidade suspeita ou falha crítica detectada neste lote.
          </div>
        ) : (
          <div className="space-y-3">
            {findings.map((f) => {
              const isResolved = Boolean(f.resolvedAction);
              return (
                <article
                  key={f.id}
                  className={`sf-card p-4 space-y-2.5 ${
                    isResolved ? 'opacity-70' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {renderSeverityBadge(f.severity)}
                        <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-[10px] font-mono font-bold text-slate-600 dark:text-slate-300">
                          {f.type}
                        </span>
                        {isResolved && (
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px] font-bold">
                            Resolvido: {f.resolvedAction}
                          </span>
                        )}
                      </div>
                      <h5 className="text-xs sm:text-sm font-extrabold text-[#0F172A] dark:text-white">
                        {f.title}
                      </h5>
                    </div>
                    {f.amountCents !== undefined && f.amountCents > 0 && (
                      <strong className="font-money text-sm font-extrabold text-[#0F172A] dark:text-white tabular-nums shrink-0">
                        {formatarValor(fromCents(f.amountCents), hideValues)}
                      </strong>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] bg-slate-50 dark:bg-white/5 rounded-xl p-3 border border-slate-200/70 dark:border-white/10">
                    <div>
                      <span className="block font-bold text-slate-500 uppercase text-[10px]">
                        Evidência
                      </span>
                      <p className="text-[#0F172A] dark:text-slate-200 mt-0.5 break-words">
                        {f.evidence}
                      </p>
                    </div>
                    <div>
                      <span className="block font-bold text-slate-500 uppercase text-[10px]">
                        Explicação
                      </span>
                      <p className="text-[#0F172A] dark:text-slate-200 mt-0.5">
                        {f.explanation}
                      </p>
                    </div>
                    <div>
                      <span className="block font-bold text-slate-500 uppercase text-[10px]">
                        Recomendação
                      </span>
                      <p className="text-[#0F172A] dark:text-slate-200 mt-0.5">
                        {f.recommendation}
                      </p>
                    </div>
                  </div>

                  {!isResolved && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {f.availableActions.includes('CONFIRM_DUPLICATE') && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplyDecision({
                              movementId: f.targetMovementId,
                              findingId: f.id,
                              decision: 'CONFIRM_DUPLICATE',
                            })
                          }
                          className="min-h-8 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold cursor-pointer"
                        >
                          Confirmar duplicidade
                        </button>
                      )}
                      {f.availableActions.includes('KEEP_BOTH') && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplyDecision({
                              movementId: f.targetMovementId,
                              findingId: f.id,
                              decision: 'KEEP_BOTH',
                            })
                          }
                          className="min-h-8 px-3 rounded-lg bg-[#059669] hover:bg-emerald-700 text-white text-[11px] font-bold cursor-pointer"
                        >
                          Manter ambos
                        </button>
                      )}
                      {f.availableActions.includes('LINK_MOVEMENTS') && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplyDecision({
                              movementId: f.targetMovementId,
                              findingId: f.id,
                              decision: 'LINK_MOVEMENTS',
                            })
                          }
                          className="min-h-8 px-3 rounded-lg bg-[#061E3E] text-white text-[11px] font-bold cursor-pointer"
                        >
                          Vincular movimentações
                        </button>
                      )}
                      {f.availableActions.includes('EDIT_MOVEMENT') && f.targetMovementId && (
                        <button
                          type="button"
                          onClick={() => onOpenMovementEdit(f.targetMovementId!)}
                          className="min-h-8 px-3 rounded-lg border border-slate-200 dark:border-white/15 text-[11px] font-bold text-[#0F172A] dark:text-white cursor-pointer"
                        >
                          Editar item
                        </button>
                      )}
                      {f.availableActions.includes('MANUAL_REVIEW') && (
                        <button
                          type="button"
                          onClick={onGoToReview}
                          className="min-h-8 px-3 rounded-lg border border-slate-200 dark:border-white/15 text-[11px] font-bold text-[#0F172A] dark:text-white cursor-pointer"
                        >
                          Revisar item
                        </button>
                      )}
                      {f.availableActions.includes('REPROCESS_BATCH') && onReprocessBatch && (
                        <button
                          type="button"
                          onClick={onReprocessBatch}
                          className="min-h-8 px-3 rounded-lg border border-slate-200 dark:border-white/15 text-[11px] font-bold text-[#0F172A] dark:text-white cursor-pointer"
                        >
                          Reprocessar lote
                        </button>
                      )}
                      {f.availableActions.includes('IGNORE_ALERT') && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplyDecision({
                              movementId: f.targetMovementId,
                              findingId: f.id,
                              decision: 'IGNORE_ALERT',
                            })
                          }
                          className="min-h-8 px-3 rounded-lg text-[11px] font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 cursor-pointer"
                        >
                          Ignorar alerta
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
