import type { Account, CreditCard, Transaction } from '../../types';
import type {
  AuditFinding,
  AuditLifecycleStatus,
  CardInvoiceIntegrityReport,
  DuplicateUserDecision,
  ExtractionBatch,
  FinancialIntegrityAuditReport,
} from '../../types-sub/extractions';
import { cents, fromCents, subtractMoney, toCents } from '../money/money';
import type { MoneyCents } from '../money/money';
import { generateEntityId } from '../common/id';
import { computeBillingCycleDates } from './../cards/CardLedgerService';
import {
  analyzeCardInstallmentCommitments,
  type AuditedInvoiceResult,
} from '../cards/CardInvoiceAuditorService';

function isValidIsoDateString(d?: string): boolean {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(dt.getTime());
}

/**
 * Phase 3 & 4 FinancialIntegrityEngine:
 * Audits bank/brokerage extraction batches (6.1 + 6.2) without ever mutating balances or deleting movements.
 */
export function auditExtractionBatchIntegrity(params: {
  batch: ExtractionBatch;
  accounts: Account[];
  creditCards: CreditCard[];
  transactions: Transaction[];
}): FinancialIntegrityAuditReport {
  const { batch, accounts, creditCards, transactions } = params;
  const nowIso = new Date().toISOString();
  const findings: AuditFinding[] = [];

  const accId = batch.confirmedAccountId || batch.identifiedAccount.matchedAccountId;
  const cardId = batch.confirmedCardId || batch.identifiedAccount.matchedCardId;
  const boundAcc = accounts.find((a) => a.id === accId && !a.archived);
  const boundCard = creditCards.find((c) => c.id === cardId);
  const resolvedEntity = batch.confirmedEntityId || batch.identifiedAccount.holderNature || boundAcc?.entityId || boundCard?.entityId;

  const validFile = batch.fileSizeBytes > 0 && Boolean(batch.contentFingerprint);
  const bankIdentified = Boolean(batch.identifiedAccount.bankName && batch.identifiedAccount.bankName.trim());
  const accountConfirmed = Boolean(boundAcc || boundCard);
  const entityValid = resolvedEntity === 'CPF' || resolvedEntity === 'CNPJ';

  const invalidDateMovs = batch.movements.filter((m) => !isValidIsoDateString(m.date));
  const invalidAmountMovs = batch.movements.filter((m) => !Number.isFinite(m.amountCents) || m.amountCents <= 0);
  const missingCurrencyMovs = batch.movements.filter((m) => !m.currency || m.currency.trim().length !== 3);
  const missingSnapshotMovs = batch.movements.filter((m) => !m.rawRowSnapshot || Object.keys(m.rawRowSnapshot).length === 0);

  const creditsIdentified = batch.movements.some((m) => m.direction === 'INCOME') || batch.balanceSummary.creditsCents >= 0;
  const debitsIdentified = batch.movements.some((m) => m.direction === 'EXPENSE') || batch.balanceSummary.debitsCents >= 0;
  const openingRecognized = batch.balanceSummary.openingBalanceCents !== undefined;
  const endingRecognized = batch.balanceSummary.reportedEndingBalanceCents !== undefined;
  const duplicatesEvaluated = batch.movements.every((m) => Boolean(m.duplicateStatus));
  const internalTransfersHandled = batch.movements
    .filter((m) => m.movementType === 'TRANSFERENCIA' || m.duplicateStatus === 'TRANSFERENCIA_PROPRIA')
    .every((m) => Boolean(m.transferCounterpartAccountId) || m.duplicateMatchReason !== undefined);

  const checklist: FinancialIntegrityAuditReport['checklist'] = [
    { code: 'FILE_VALID', label: 'Arquivo válido e íntegro', passed: validFile },
    { code: 'BANK_IDENTIFIED', label: 'Banco ou instituição identificado(a)', passed: bankIdentified, detail: batch.identifiedAccount.bankName },
    { code: 'ACCOUNT_CONFIRMED', label: 'Conta ou cartão confirmado', passed: accountConfirmed },
    { code: 'ENTITY_VALID', label: 'Titularidade / Entidade (CPF/CNPJ) correta', passed: entityValid, detail: resolvedEntity },
    { code: 'DATES_VALID', label: 'Datas válidas', passed: invalidDateMovs.length === 0 },
    { code: 'AMOUNTS_VALID', label: 'Valores monetários válidos (> 0)', passed: invalidAmountMovs.length === 0 },
    { code: 'CREDITS_IDENTIFIED', label: 'Créditos identificados', passed: creditsIdentified },
    { code: 'DEBITS_IDENTIFIED', label: 'Débitos identificados', passed: debitsIdentified },
    { code: 'CURRENCY_IDENTIFIED', label: 'Moeda identificada', passed: missingCurrencyMovs.length === 0 },
    { code: 'OPENING_BALANCE', label: 'Saldo inicial reconhecido', passed: openingRecognized },
    { code: 'ENDING_BALANCE', label: 'Saldo final reconhecido', passed: endingRecognized },
    { code: 'DUPLICATES_EVALUATED', label: 'Movimentações duplicadas avaliadas', passed: duplicatesEvaluated },
    { code: 'TRANSFERS_RECOGNIZED', label: 'Transferências internas reconhecidas', passed: internalTransfersHandled },
    { code: 'SOURCE_PRESERVED', label: 'Dados de origem preservados', passed: missingSnapshotMovs.length === 0 },
  ];

  // Structural & Critical Findings
  if (!accountConfirmed) {
    findings.push({
      id: generateEntityId('aud'),
      type: 'CONTA_NAO_CONFIRMADA',
      severity: 'CRITICAL',
      domain: 'INTEGRITY',
      title: 'Conta bancária ou cartão não vinculado ao lote',
      evidence: `Banco detectado: ${batch.identifiedAccount.bankName || 'Não identificado'}`,
      explanation: 'Sem associação explícita a uma conta ou cartão cadastrado, os lançamentos não podem ser integrados com segurança.',
      recommendation: 'Selecione ou cadastre a conta correspondente no painel de Revisão antes de efetivar.',
      availableActions: ['MANUAL_REVIEW'],
    });
  }

  if (!entityValid) {
    findings.push({
      id: generateEntityId('aud'),
      type: 'TITULARIDADE_PENDENTE',
      severity: 'CRITICAL',
      domain: 'INTEGRITY',
      title: 'Titularidade CPF/CNPJ não confirmada',
      evidence: batch.identifiedAccount.maskedDocument || 'Documento ausente no cabeçalho',
      explanation: 'O sistema exige confirmação clara entre conta pessoal (CPF) e empresarial (CNPJ).',
      recommendation: 'Confirme a titularidade do extrato na seção de conta identificada.',
      availableActions: ['MANUAL_REVIEW'],
    });
  }

  if (invalidAmountMovs.length > 0 || invalidDateMovs.length > 0) {
    for (const m of [...invalidAmountMovs, ...invalidDateMovs]) {
      findings.push({
        id: generateEntityId('aud'),
        type: 'MOVIMENTACAO_INVALIDA',
        severity: 'CRITICAL',
        domain: 'STATEMENT',
        title: `Lançamento com dado inválido: ${m.originalDescription}`,
        amountCents: m.amountCents,
        evidence: `Data: ${m.date || 'ausente'} · Valor: ${fromCents(m.amountCents)}`,
        explanation: 'Datas inválidas ou valores zerados/ilegíveis bloqueiam integração automática.',
        recommendation: 'Edite o lançamento conferindo com o documento original ou ignore o item.',
        availableActions: ['EDIT_MOVEMENT', 'IGNORE_ALERT'],
        targetMovementId: m.id,
      });
    }
  }

  // 6.2 Mathematical Reconciliation check (NEVER alter reported or official balance!)
  if (batch.balanceSummary.hasDivergence && batch.balanceSummary.divergenceCents !== undefined) {
    const divCents = batch.balanceSummary.divergenceCents;
    const calcEnd = batch.balanceSummary.calculatedEndingBalanceCents ?? cents(0);
    const repEnd = batch.balanceSummary.reportedEndingBalanceCents ?? cents(0);
    findings.push({
      id: generateEntityId('aud'),
      type: 'DIVERGENCIA_CONCILIACAO_SALDO',
      severity: 'WARNING',
      domain: 'STATEMENT',
      title: 'Divergência matemática entre saldo informado e saldo calculado',
      amountCents: cents(Math.abs(divCents)),
      evidence: `Saldo calculado: R$ ${fromCents(calcEnd).toFixed(2)} | Saldo informado: R$ ${fromCents(repEnd).toFixed(2)} | Diferença: R$ ${fromCents(divCents).toFixed(2)}`,
      explanation: 'A equação Saldo inicial + Créditos − Débitos divergiu do saldo final informado no documento. O sistema preservou ambos os valores sem forçar igualdade.',
      recommendation: 'Verifique se o saldo inicial foi informado corretamente, se há lançamentos fora do período ou tarifas não lidas.',
      availableActions: ['REPROCESS_BATCH', 'MANUAL_REVIEW', 'IGNORE_ALERT'],
    });
  }

  if (!openingRecognized || !endingRecognized) {
    findings.push({
      id: generateEntityId('aud'),
      type: 'SALDO_DOCUMENTO_AUSENTE',
      severity: 'INFO',
      domain: 'STATEMENT',
      title: 'Saldo inicial ou final ausente no documento',
      evidence: `Inicial: ${openingRecognized ? 'Sim' : 'Não'} · Final: ${endingRecognized ? 'Sim' : 'Não'}`,
      explanation: 'O arquivo não apresentou ambos os saldos de conferência para validação matemática completa.',
      recommendation: 'Caso deseje conciliação fechada, informe o saldo inicial manualmente na aba Conciliação.',
      availableActions: ['MANUAL_REVIEW', 'IGNORE_ALERT'],
    });
  }

  // Updated-source & Duplicate findings
  for (const m of batch.movements) {
    if (m.duplicateResolution) continue;

    if (m.syncState === 'UPDATED_SOURCE') {
      findings.push({
        id: generateEntityId('aud'),
        type: 'ORIGEM_ATUALIZADA',
        severity: 'WARNING',
        domain: 'DUPLICATION',
        title: `Registro atualizado na origem: ${m.originalDescription}`,
        amountCents: m.amountCents,
        evidence: m.updatedSourceDiff?.join('; ') || m.duplicateMatchReason || 'Diferença detectada no mesmo ID bancário.',
        explanation: 'O identificador bancário já existia, porém descrição, data ou valor mudou em relação à importação anterior.',
        recommendation: 'Revise se a alteração na origem deve substituir/vincular ou permanecer separada.',
        availableActions: ['CONFIRM_DUPLICATE', 'KEEP_BOTH', 'LINK_MOVEMENTS', 'IGNORE_ALERT'],
        targetMovementId: m.id,
        targetTransactionId: m.duplicateMatchTxId,
      });
    } else if (m.duplicateStatus === 'POSSIVEL_DUPLICIDADE') {
      findings.push({
        id: generateEntityId('aud'),
        type: m.duplicateLayer === 'SUSPEITA' ? 'DUPLICIDADE_SUSPEITA' : 'DUPLICIDADE_PROVAVEL',
        severity: 'WARNING',
        domain: 'DUPLICATION',
        title: `${m.duplicateLayer === 'SUSPEITA' ? 'Compra repetida / suspeita' : 'Possível duplicidade'}: ${m.originalDescription}`,
        amountCents: m.amountCents,
        evidence: m.duplicateMatchReason || 'Correspondência parcial encontrada.',
        explanation: 'O motor de integridade nunca exclui registros semelhantes automaticamente para não perder compras legítimas no mesmo dia.',
        recommendation: 'Decida explicitamente se deseja confirmar duplicidade, manter ambos os lançamentos ou vincular.',
        availableActions: ['CONFIRM_DUPLICATE', 'KEEP_BOTH', 'LINK_MOVEMENTS', 'IGNORE_ALERT'],
        targetMovementId: m.id,
        targetTransactionId: m.duplicateMatchTxId,
      });
    } else if (m.reviewStatus === 'PRECISA_IDENTIFICACAO') {
      findings.push({
        id: generateEntityId('aud'),
        type: 'CLASSIFICACAO_INCERTA',
        severity: 'WARNING',
        domain: 'STATEMENT',
        title: `Classificação incerta: ${m.originalDescription}`,
        amountCents: m.amountCents,
        evidence: m.doubtReason || `Confiança ${Math.round(m.confidence * 100)}%`,
        explanation: 'A leitura ou categorização automática possui baixa confiança ou termo ambíguo.',
        recommendation: 'Revise e edite o lançamento antes de aprovar.',
        availableActions: ['EDIT_MOVEMENT', 'ACCEPT_SUGGESTION', 'IGNORE_ALERT'],
        targetMovementId: m.id,
      });
    }
  }

  // If linked to a Credit Card and contains installment items, audit installment commitments (Phase 4)
  if (boundCard) {
    const instAnalysis = analyzeCardInstallmentCommitments({
      transactions,
      targetCard: boundCard,
    });
    for (const item of instAnalysis.items) {
      if (item.warnings.length > 0) {
        findings.push({
          id: generateEntityId('aud'),
          type: 'PARCELAMENTO_ALERTA',
          severity: 'WARNING',
          domain: 'INSTALLMENT',
          title: `Alerta de parcelamento no cartão ${boundCard.cardName}: ${item.description}`,
          amountCents: item.installmentAmountCents,
          evidence: item.warnings.join(' '),
          explanation: 'Divergência ou sobreposição identificada na série de parcelas do cartão.',
          recommendation: 'Confira as parcelas projetadas na fatura antes de aprovar novas projeções.',
          availableActions: ['MANUAL_REVIEW', 'IGNORE_ALERT'],
        });
      }
    }
  }

  const hasCritical = findings.some((f) => f.severity === 'CRITICAL' && !f.resolvedAction);
  const hasAnyUnresolvedWarning = findings.some((f) => f.severity === 'WARNING' && !f.resolvedAction);

  return {
    auditedAt: nowIso,
    domain: boundCard && !boundAcc ? 'CARD_INVOICE' : 'STATEMENT',
    passed: !hasCritical && !hasAnyUnresolvedWarning,
    blocked: hasCritical && batch.movements.length > 0 && (!accountConfirmed || !entityValid),
    checklist,
    findings,
  };
}

/**
 * Phase 3 (6.3) + Phase 4 Credit Card Invoice Integrity Audit.
 * Never overwrites reported vs calculated totals to force equality.
 */
export function auditCardInvoiceIntegrity(params: {
  audited: AuditedInvoiceResult;
  card: CreditCard;
  existingTransactions: readonly Transaction[];
  priorBalanceCents?: MoneyCents;
  paymentsCents?: MoneyCents;
  closingDate?: string;
}): CardInvoiceIntegrityReport {
  const {
    audited,
    card,
    existingTransactions,
    priorBalanceCents = cents(0),
    paymentsCents = cents(0),
    closingDate,
  } = params;

  let purchases = 0;
  let installments = 0;
  let feesAndTaxes = 0;
  let interestAndFines = 0;
  let reversalsAndCashback = 0;

  const findings: AuditFinding[] = [];

  for (const tx of audited.transacoes) {
    const valCents = toCents(Math.abs(tx.valor)) as number;
    if (tx.valor < 0) {
      reversalsAndCashback += valCents;
      continue;
    }

    const lowerDesc = tx.descricao.toLowerCase();
    if (/\b(juros|multa|encargo|mora)\b/i.test(lowerDesc)) {
      interestAndFines += valCents;
    } else if (/\b(iof|tarifa|anuidade|taxa)\b/i.test(lowerDesc)) {
      feesAndTaxes += valCents;
    } else if (tx.tipo === 'parcelada' || tx.total_parcelas > 1) {
      installments += valCents;
    } else {
      purchases += valCents;
    }
  }

  const calculatedNetNum =
    purchases +
    installments +
    feesAndTaxes +
    interestAndFines -
    reversalsAndCashback +
    (priorBalanceCents as number) -
    (paymentsCents as number);

  const calculatedNetCents = cents(Math.max(0, calculatedNetNum));
  const reportedTotalCents = toCents(Math.max(0, audited.resumo_fatura.valor_total_identificado));
  const divergenceCents = subtractMoney(reportedTotalCents, calculatedNetCents);
  const hasDivergence = reportedTotalCents > 0 && Math.abs(divergenceCents) > 5; // > R$ 0,05 tolerance for rounding

  const dueDate = audited.resumo_fatura.vencimento || undefined;
  const cycleInfo = computeBillingCycleDates(
    dueDate || audited.transacoes[0]?.data || new Date().toISOString().slice(0, 10),
    card.closingDay,
    card.dueDay
  );

  if (hasDivergence) {
    findings.push({
      id: generateEntityId('caud'),
      type: 'DIVERGENCIA_TOTAL_FATURA',
      severity: 'WARNING',
      domain: 'CARD_INVOICE',
      title: `Divergência entre total da fatura informado e soma auditada (${card.cardName})`,
      amountCents: cents(Math.abs(divergenceCents)),
      evidence: `Total informado: R$ ${fromCents(reportedTotalCents).toFixed(2)} | Soma calculada: R$ ${fromCents(calculatedNetCents).toFixed(2)} | Diferença: R$ ${fromCents(divergenceCents).toFixed(2)}`,
      explanation: 'O total identificado na fatura difere da soma líquida de compras à vista, parcelas, tarifas/IOF, juros/multas e estornos. Nenhum valor foi ajustado artificialmente.',
      recommendation: 'Confira se há pagamento antecipado, saldo anterior ou item não extraído no documento original.',
      availableActions: ['MANUAL_REVIEW', 'IGNORE_ALERT'],
    });
  }

  if (!dueDate) {
    findings.push({
      id: generateEntityId('caud'),
      type: 'VENCIMENTO_FATURA_AUSENTE',
      severity: 'INFO',
      domain: 'CARD_INVOICE',
      title: 'Vencimento não identificado explicitamente no documento',
      evidence: `Ciclo estimado pelo cadastro do cartão: fechamento dia ${card.closingDay}, vencimento dia ${card.dueDay}.`,
      explanation: 'A data exata de vencimento não constava no cabeçalho extraído.',
      recommendation: 'Confirme se o ciclo estimado corresponde à fatura atual.',
      availableActions: ['MANUAL_REVIEW', 'IGNORE_ALERT'],
    });
  }

  const installmentSummary = analyzeCardInstallmentCommitments({
    transactions: existingTransactions,
    audited,
    targetCard: card,
  });

  for (const item of installmentSummary.items) {
    if (item.hasDuplicateRisk || item.warnings.length > 0) {
      findings.push({
        id: generateEntityId('caud'),
        type: 'PARCELAMENTO_SOBREPOSICAO_OU_DUPLICIDADE',
        severity: 'WARNING',
        domain: 'INSTALLMENT',
        title: `Parcelamento "${item.description}" requer atenção`,
        amountCents: item.installmentAmountCents,
        evidence: item.warnings.join(' ') || `Parcela ${item.installmentCurrent}/${item.installmentTotal}`,
        explanation: 'Evitamos gerar parcelas futuras duplicadas quando a compra já possui projeção ou registro no ciclo.',
        recommendation: 'Revise a seleção do lançamento e a opção de projeção futura antes de confirmar.',
        availableActions: ['MANUAL_REVIEW', 'IGNORE_ALERT'],
      });
    }
  }

  return {
    cardId: card.id,
    cardName: card.cardName,
    dueDate,
    closingDate: closingDate || cycleInfo.closingDate,
    cycleYm: cycleInfo.cycleYm,
    reportedTotalCents,
    calculatedNetCents,
    purchasesCents: cents(purchases),
    installmentsCents: cents(installments),
    feesAndTaxesCents: cents(feesAndTaxes),
    interestAndFinesCents: cents(interestAndFines),
    reversalsAndCashbackCents: cents(reversalsAndCashback),
    paymentsCents,
    priorBalanceCents,
    divergenceCents,
    hasDivergence,
    installmentSummary,
    findings,
  };
}

export function resolveAuditLifecycleStatus(
  batch: ExtractionBatch,
  report: FinancialIntegrityAuditReport
): AuditLifecycleStatus {
  if (batch.status === 'ERRO') return 'FAILED';
  if (batch.status === 'CONCLUIDO') {
    const hasWarnings = report.findings.some((f) => f.severity === 'WARNING' && !f.resolvedAction);
    return hasWarnings ? 'APPROVED_WITH_WARNINGS' : 'INTEGRATED';
  }
  if (report.blocked) return 'BLOCKED';
  const hasApproved = batch.movements.some((m) => m.reviewStatus === 'APROVADO');
  const hasWarnings = report.findings.some((f) => f.severity === 'WARNING' && !f.resolvedAction);
  if (batch.status === 'APROVADO_PARCIAL' || hasApproved) {
    return hasWarnings ? 'APPROVED_WITH_WARNINGS' : 'APPROVED';
  }
  return 'READY_FOR_REVIEW';
}

export function applyDuplicateUserDecision(params: {
  batch: ExtractionBatch;
  movementId?: string;
  findingId?: string;
  decision: DuplicateUserDecision | 'IGNORE_ALERT';
  note?: string;
  linkedTargetId?: string;
}): ExtractionBatch {
  const { batch, movementId, findingId, decision, note, linkedTargetId } = params;
  const nowIso = new Date().toISOString();

  const nextMovements = batch.movements.map((m) => {
    if (!movementId || m.id !== movementId) return m;
    const nextReviewStatus =
      decision === 'CONFIRM_DUPLICATE'
        ? 'DUPLICIDADE'
        : decision === 'KEEP_BOTH'
          ? m.reviewStatus === 'DUPLICIDADE'
            ? 'PENDENTE'
            : m.reviewStatus
          : decision === 'IGNORE_ALERT'
            ? m.reviewStatus
            : m.reviewStatus;

    return {
      ...m,
      reviewStatus: nextReviewStatus,
      duplicateResolution: {
        decision,
        decidedAt: nowIso,
        actor: 'USUARIO' as const,
        note,
        linkedTargetId,
      },
      manualCorrections: [
        ...m.manualCorrections,
        `Decisão de auditoria (${decision}) em ${nowIso}${note ? `: ${note}` : ''}`,
      ],
      lineage: [
        ...m.lineage,
        {
          timestamp: nowIso,
          stage: 'AUDITORIA',
          actor: 'USUARIO' as const,
          detail: `Decisão explícita do usuário sobre alerta/duplicidade: ${decision}.`,
        },
      ],
    };
  });

  const nextFindings = (batch.integrityAudit?.findings || []).map((f) => {
    const matchesFinding = findingId && f.id === findingId;
    const matchesMovement = movementId && f.targetMovementId === movementId;
    if (!matchesFinding && !matchesMovement) return f;
    return {
      ...f,
      resolvedAction: decision,
      resolvedAt: nowIso,
      resolvedBy: 'Usuário',
    };
  });

  const nextAudit = batch.integrityAudit
    ? {
        ...batch.integrityAudit,
        findings: nextFindings,
        passed: nextFindings.every((f) => f.severity === 'INFO' || Boolean(f.resolvedAction)),
      }
    : undefined;

  const nextCorrections = [
    ...(batch.correctionsHistory || []),
    {
      timestamp: nowIso,
      actor: 'USUARIO' as const,
      targetMovementId: movementId,
      field: 'duplicidade_auditoria',
      detail: `Decisão ${decision} registrada pelo usuário${note ? ` (${note})` : ''}.`,
    },
  ];

  return {
    ...batch,
    movements: nextMovements,
    ...(nextAudit ? { integrityAudit: nextAudit } : {}),
    correctionsHistory: nextCorrections,
  };
}
