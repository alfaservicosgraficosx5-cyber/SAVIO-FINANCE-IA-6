import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryRule, CreditCard, EntityId, Transaction } from '../../types';
import { Sheet } from '../Sheet';
import { BankLogo } from '../BankLogo';
import { ALL_CARD_CATEGORIES } from '../../domain/cards/CardInvoiceAuditorService';
import {
  buildImportedCardTransactions,
  buildLearnedClassificationRules,
  importCardStatement,
  type ImportedCardStatementRow,
  type StatementImportPreviewResult,
} from '../../services/statementImporter';
import { buildImportBatchFingerprint } from '../../domain/imports/SpreadsheetImportService';
import { cents, fromCents } from '../../domain/money/money';
import { formatDateBR } from '../../utils/dateUtils';
import { formatarValor } from '../../utils/formatters';
import { usePrivacy } from '../../contexts/PrivacyContext';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FileText,
  Layers,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';

interface CardInvoiceImportModalProps {
  open: boolean;
  cards: readonly CreditCard[];
  initialCardId?: string | null;
  transactions: readonly Transaction[];
  categoryRules: readonly CategoryRule[];
  onClose: () => void;
  onCommitCardImport: (
    items: Omit<Transaction, 'id'>[],
    meta: { fileName: string; batchFingerprint: string; cardId: string }
  ) => { acceptedCount: number; skippedDuplicatesCount: number };
  onUpsertCategoryRules?: (rules: CategoryRule[]) => void;
}

export const CardInvoiceImportModal: React.FC<CardInvoiceImportModalProps> = ({
  open,
  cards,
  initialCardId = null,
  transactions,
  categoryRules,
  onClose,
  onCommitCardImport,
  onUpsertCategoryRules,
}) => {
  const { hideValues } = usePrivacy();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedCardId, setSelectedCardId] = useState<string>(
    () => initialCardId || cards[0]?.id || ''
  );
  const [fileName, setFileName] = useState('');
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileMime, setFileMime] = useState('');
  const [preview, setPreview] = useState<StatementImportPreviewResult | null>(null);
  const [rows, setRows] = useState<ImportedCardStatementRow[]>([]);
  const [generateFutureInstallments, setGenerateFutureInstallments] = useState(true);
  const [learnRulesOnConfirm, setLearnRulesOnConfirm] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [commitSuccessMsg, setCommitSuccessMsg] = useState('');

  useEffect(() => {
    if (!open) return;
    if (initialCardId && cards.some((c) => c.id === initialCardId)) {
      setSelectedCardId(initialCardId);
    } else if (!selectedCardId && cards[0]?.id) {
      setSelectedCardId(cards[0].id);
    }
  }, [open, initialCardId, cards, selectedCardId]);

  const targetCard = useMemo(
    () => cards.find((c) => c.id === selectedCardId) || cards[0] || null,
    [cards, selectedCardId]
  );

  const resetModalState = () => {
    setFileName('');
    setFileBuffer(null);
    setFileMime('');
    setPreview(null);
    setRows([]);
    setErrorMsg('');
    setCommitSuccessMsg('');
    setBusy(false);
  };

  const handleClose = () => {
    resetModalState();
    onClose();
  };

  const runStatementImport = async (
    buffer: ArrayBuffer,
    name: string,
    mime: string,
    card: CreditCard
  ) => {
    setBusy(true);
    setErrorMsg('');
    setCommitSuccessMsg('');
    try {
      const result = await importCardStatement({
        fileName: name,
        mimeType: mime,
        buffer,
        card,
        existingTransactions: transactions,
        classificationRules: categoryRules,
        allowAiFallback: true,
      });
      setPreview(result);
      setRows(result.rows);
      if (result.rows.length === 0) {
        setErrorMsg(
          'Nenhuma compra, tarifa ou estorno identificado neste arquivo. Confira se o extrato é do cartão de crédito.'
        );
      }
    } catch (err) {
      setPreview(null);
      setRows([]);
      setErrorMsg(
        err instanceof Error ? err.message : 'Não foi possível processar o arquivo da fatura.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !targetCard) return;

    try {
      const buffer = await file.arrayBuffer();
      setFileName(file.name);
      setFileBuffer(buffer);
      setFileMime(file.type || '');
      await runStatementImport(buffer, file.name, file.type || '', targetCard);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Falha ao ler o arquivo selecionado.'
      );
    }
  };

  const handleCardSwitch = async (nextCardId: string) => {
    setSelectedCardId(nextCardId);
    const nextCard = cards.find((c) => c.id === nextCardId);
    if (nextCard && fileBuffer && fileName) {
      await runStatementImport(fileBuffer, fileName, fileMime, nextCard);
    }
  };

  const summary = useMemo(() => {
    let selectedNetCents = 0;
    let selectedCount = 0;
    let futureInstallmentsCount = 0;
    let ignoredDuplicatesCount = 0;

    for (const r of rows) {
      if (r.alreadyImported) {
        ignoredDuplicatesCount += 1;
        continue;
      }
      if (!r.selected) continue;
      selectedCount += 1;
      selectedNetCents +=
        r.direction === 'INCOME' ? -(r.amountCents as number) : (r.amountCents as number);
      if (r.cardEntryKind === 'INSTALLMENT' && r.installmentTotal > r.installmentCurrent) {
        futureInstallmentsCount += r.installmentTotal - r.installmentCurrent;
      }
    }

    return {
      totalFaturaCents: preview?.invoiceTotalCents ?? cents(Math.max(0, selectedNetCents)),
      selectedNetCents: cents(Math.max(0, selectedNetCents)),
      selectedCount,
      futureInstallmentsCount,
      ignoredDuplicatesCount,
    };
  }, [rows, preview]);

  const handleToggleRowProfile = (rowId: string, profile: EntityId) => {
    setRows((prev) =>
      prev.map((item) => (item.rowId === rowId ? { ...item, profile } : item))
    );
  };

  const handleChangeRowCategory = (rowId: string, category: string) => {
    setRows((prev) =>
      prev.map((item) => (item.rowId === rowId ? { ...item, category } : item))
    );
  };

  const handleToggleRowSelected = (rowId: string, checked: boolean) => {
    setRows((prev) =>
      prev.map((item) =>
        item.rowId === rowId && !item.alreadyImported
          ? { ...item, selected: checked }
          : item
      )
    );
  };

  const handleConfirmAndImport = () => {
    if (!targetCard) return;
    setErrorMsg('');

    const importBatchId = `imp-card-${Date.now()}`;
    const payload = buildImportedCardTransactions({
      rows,
      targetCard,
      importBatchId,
      generateFutureInstallments,
      existingTransactions: transactions,
    });

    if (payload.length === 0) {
      setErrorMsg('Nenhum novo lançamento selecionado para importação.');
      return;
    }

    const fingerprint = buildImportBatchFingerprint({
      fileName: fileName || 'fatura',
      sheetName: preview?.format || 'Fatura',
      accountId: targetCard.id,
      rowCount: payload.length,
      sampleSignature: payload[0]?.import_hash || targetCard.id,
    });

    const result = onCommitCardImport(payload, {
      fileName: fileName || `fatura_${targetCard.cardName}`,
      batchFingerprint: fingerprint,
      cardId: targetCard.id,
    });

    let learnedCount = 0;
    if (learnRulesOnConfirm && onUpsertCategoryRules) {
      const learned = buildLearnedClassificationRules({
        rows,
        cardId: targetCard.id,
        existingRules: categoryRules,
      });
      if (learned.length > 0) {
        onUpsertCategoryRules(learned);
        learnedCount = learned.length;
      }
    }

    setCommitSuccessMsg(
      `Fatura importada: ${result.acceptedCount} lançamento(s) gravado(s)` +
        (result.skippedDuplicatesCount > 0
          ? ` · ${result.skippedDuplicatesCount} duplicado(s) ignorado(s)`
          : '') +
        (learnedCount > 0
          ? ` · ${learnedCount} regra(s) de classificação memorizada(s)`
          : '') +
        '.'
    );
  };

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      title="Importar Fatura de Cartão"
      subtitle="Leitura automática PDF, CSV e OFX · Filtro contábil · Parcelas futuras · Blindagem SHA-256"
    >
      <div className="space-y-4">
        {cards.length === 0 ? (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0" />
            <span>Cadastre um cartão de crédito primeiro para importar sua fatura.</span>
          </div>
        ) : (
          <>
            {/* Target Card Selector */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {targetCard && (
                  <BankLogo
                    bankName={targetCard.institutionName}
                    bankCode={targetCard.bankCode}
                    logoUrl={targetCard.logoUrl}
                    size={36}
                  />
                )}
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-[#64748B] dark:text-slate-400">
                    Cartão de destino
                  </div>
                  <div className="text-xs font-bold text-[#0F172A] dark:text-white truncate">
                    {targetCard
                      ? `${targetCard.institutionName} · ${targetCard.cardName} (•••• ${targetCard.last4})`
                      : 'Selecione um cartão'}
                  </div>
                </div>
              </div>

              {cards.length > 1 && (
                <select
                  value={targetCard?.id || ''}
                  onChange={(e) => void handleCardSwitch(e.target.value)}
                  aria-label="Selecionar cartão para importar fatura"
                  className="min-h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-[#0F172A] dark:text-white"
                >
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.institutionName} · {c.cardName} ({c.entityId})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* File Drop / Upload Box */}
            <div className="rounded-2xl border-2 border-dashed border-emerald-500/40 dark:border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 text-center space-y-2.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.csv,.ofx,.txt,.png,.jpg,.jpeg,.webp"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="flex justify-center">
                <span className="w-10 h-10 rounded-xl bg-[#059669]/15 text-[#059669] dark:text-[#10B981] flex items-center justify-center">
                  {busy ? <RefreshCw size={20} className="animate-spin" /> : <Upload size={20} />}
                </span>
              </div>
              <div>
                <p className="text-xs sm:text-sm font-bold text-[#0F172A] dark:text-white">
                  {fileName
                    ? `Arquivo carregado: ${fileName}`
                    : 'Selecione a fatura em PDF, CSV ou OFX'}
                </p>
                <p className="text-[11px] text-[#64748B] dark:text-slate-400 mt-0.5">
                  Compatível com Nubank, Itaú, Bradesco, C6, Inter, Sicredi, Sicoob e Banco do Brasil.
                </p>
              </div>
              <button
                type="button"
                disabled={busy || !targetCard}
                onClick={() => fileInputRef.current?.click()}
                className="min-h-10 px-4 rounded-xl bg-[#061E3E] hover:bg-[#0F172A] dark:bg-[#059669] dark:hover:bg-emerald-700 text-white text-xs font-bold inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <FileText size={14} />
                {fileName ? 'Trocar arquivo' : 'Escolher arquivo da fatura'}
              </button>
            </div>

            {errorMsg && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                <AlertCircle size={15} className="shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {commitSuccessMsg && (
              <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200 text-xs font-semibold flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="shrink-0 text-[#059669] dark:text-[#10B981]" />
                  {commitSuccessMsg}
                </span>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3 py-1.5 rounded-lg bg-[#059669] text-white text-[11px] font-bold cursor-pointer shrink-0"
                >
                  Concluir
                </button>
              </div>
            )}

            {preview && rows.length > 0 && !commitSuccessMsg && (
              <>
                {/* Summary KPI Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#64748B] dark:text-slate-400">
                      Total da Fatura
                    </div>
                    <div className="font-money text-base font-extrabold text-[#0F172A] dark:text-white mt-0.5">
                      {formatarValor(fromCents(summary.totalFaturaCents), hideValues)}
                    </div>
                    {preview.dueDate && (
                      <div className="text-[10px] text-[#64748B] dark:text-slate-400 mt-0.5">
                        Vencimento: {formatDateBR(preview.dueDate)}
                      </div>
                    )}
                  </div>

                  <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200/80 dark:border-emerald-800/70">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#059669] dark:text-[#10B981]">
                      Novos Lançamentos
                    </div>
                    <div className="font-money text-base font-extrabold text-[#059669] dark:text-[#10B981] mt-0.5">
                      {summary.selectedCount} item(ns)
                    </div>
                    <div className="text-[10px] text-emerald-800/80 dark:text-emerald-300/80 mt-0.5">
                      {generateFutureInstallments && summary.futureInstallmentsCount > 0
                        ? `+ ${summary.futureInstallmentsCount} parcela(s) futura(s) projetada(s)`
                        : `Valor a gravar: ${formatarValor(fromCents(summary.selectedNetCents), hideValues)}`}
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/60">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                      Duplicados Ignorados
                    </div>
                    <div className="font-money text-base font-extrabold text-amber-800 dark:text-amber-300 mt-0.5">
                      {summary.ignoredDuplicatesCount}
                    </div>
                    <div className="text-[10px] text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                      {preview.ignoredAccountingLinesCount > 0
                        ? `${preview.ignoredAccountingLinesCount} pgto(s) de fatura filtrado(s)`
                        : 'Blindagem SHA-256 ativa'}
                    </div>
                  </div>
                </div>

                {/* Options */}
                <div className="space-y-2">
                  {summary.futureInstallmentsCount > 0 && (
                    <label className="flex items-center gap-2 p-2.5 rounded-xl bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200/80 dark:border-sky-800/70 text-xs text-[#0F172A] dark:text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={generateFutureInstallments}
                        onChange={(e) => setGenerateFutureInstallments(e.target.checked)}
                        className="w-4 h-4 accent-[#059669] shrink-0"
                      />
                      <span className="flex items-center gap-1.5">
                        <CalendarClock size={14} className="text-sky-600 dark:text-sky-400 shrink-0" />
                        Projetar automaticamente <strong>{summary.futureInstallmentsCount}</strong> parcela(s) futura(s) respeitando fechamento dia {targetCard?.closingDay} e vencimento dia {targetCard?.dueDay}.
                      </span>
                    </label>
                  )}

                  {onUpsertCategoryRules && (
                    <label className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/70 text-xs text-[#0F172A] dark:text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={learnRulesOnConfirm}
                        onChange={(e) => setLearnRulesOnConfirm(e.target.checked)}
                        className="w-4 h-4 accent-[#059669] shrink-0"
                      />
                      <span className="flex items-center gap-1.5">
                        <Sparkles size={14} className="text-[#059669] dark:text-[#10B981] shrink-0" />
                        Memorizar Categorias e Perfil (CPF / CNPJ) nas Regras de Classificação para próximas faturas.
                      </span>
                    </label>
                  )}
                </div>

                {/* Review Table / Cards */}
                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto border border-slate-200/80 dark:border-slate-700/80 rounded-xl bg-white dark:bg-slate-900/60">
                  {rows.map((row) => (
                    <div
                      key={row.rowId}
                      className={`p-3 flex flex-col gap-2 ${
                        row.alreadyImported ? 'opacity-65 bg-slate-50/70 dark:bg-slate-900/90' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex items-start gap-2.5 min-w-0 flex-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!row.alreadyImported && row.selected}
                            disabled={row.alreadyImported}
                            onChange={(e) =>
                              handleToggleRowSelected(row.rowId, e.target.checked)
                            }
                            className="w-4 h-4 mt-0.5 accent-[#059669] shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-[#0F172A] dark:text-white truncate">
                              {row.description}
                            </div>
                            <div className="text-[11px] text-[#64748B] dark:text-slate-400 flex flex-wrap items-center gap-1.5 mt-0.5">
                              <span>{formatDateBR(row.date)}</span>
                              {row.installmentTotal > 1 && (
                                <span className="px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300 text-[10px] font-bold inline-flex items-center gap-1">
                                  <Layers size={10} /> Parc. {row.installmentCurrent}/{row.installmentTotal}
                                </span>
                              )}
                              {row.matchedRuleKeyword && !row.alreadyImported && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-[#059669] dark:text-[#10B981] text-[10px] font-bold">
                                  Regra: {row.matchedRuleKeyword}
                                </span>
                              )}
                              {row.alreadyImported && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 text-[10px] font-bold inline-flex items-center gap-1">
                                  <ShieldCheck size={10} /> Já importado
                                </span>
                              )}
                            </div>
                          </div>
                        </label>

                        <span
                          className={`font-money text-xs font-extrabold shrink-0 ${
                            row.direction === 'INCOME'
                              ? 'text-[#059669] dark:text-[#10B981]'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {row.direction === 'INCOME' ? '−' : ''}
                          {formatarValor(fromCents(row.amountCents), hideValues)}
                        </span>
                      </div>

                      {!row.alreadyImported && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pl-6">
                          {/* Quick Category Select */}
                          <select
                            value={row.category}
                            aria-label={`Categoria para ${row.description}`}
                            onChange={(e) =>
                              handleChangeRowCategory(row.rowId, e.target.value)
                            }
                            className="min-h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-semibold text-[#0F172A] dark:text-white flex-1 min-w-[140px]"
                          >
                            {ALL_CARD_CATEGORIES.map((cat) => (
                              <option key={cat} value={cat}>
                                {cat}
                              </option>
                            ))}
                          </select>

                          {/* Quick [CPF | CNPJ] Toggle */}
                          <div
                            role="group"
                            aria-label={`Perfil para ${row.description}`}
                            className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-100 dark:bg-slate-800 shrink-0"
                          >
                            {(['CPF', 'CNPJ'] as const).map((prof) => {
                              const active = row.profile === prof;
                              return (
                                <button
                                  key={prof}
                                  type="button"
                                  onClick={() => handleToggleRowProfile(row.rowId, prof)}
                                  className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold transition-colors cursor-pointer ${
                                    active
                                      ? prof === 'CPF'
                                        ? 'bg-[#059669] text-white'
                                        : 'bg-[#061E3E] dark:bg-blue-600 text-white'
                                      : 'text-slate-500 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-white'
                                  }`}
                                >
                                  {prof}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Action Footer */}
                <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={busy || summary.selectedCount === 0}
                    onClick={handleConfirmAndImport}
                    className="flex-[1.6] min-h-11 px-5 rounded-xl bg-[#059669] hover:bg-emerald-700 text-white text-xs sm:text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-40 cursor-pointer"
                  >
                    <CheckCircle2 size={16} />
                    Confirmar e Importar ({summary.selectedCount})
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
};
