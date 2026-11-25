import type { Account, Transaction } from '../../types';
import type {
  DuplicateClassification,
  DuplicateLayer,
  DuplicateRelatedKind,
  ExtractedMovement,
  ExtractionBatch,
  MovementSyncState,
} from '../../types-sub/extractions';
import { getTransactionAmountCents, normalizeDescription } from '../../utils/financeCalculations';
import { findMatchingScheduledTransaction } from '../transactions/ImportReconciliationService';
import { computeFastHash } from './fileSecurity';

export interface DuplicateCheckResult {
  classification: DuplicateClassification;
  layer: DuplicateLayer;
  relatedKind?: DuplicateRelatedKind;
  syncState: MovementSyncState;
  duplicationConfidence: number;
  updatedSourceDiff?: string[];
  matchTxId?: string;
  matchBatchId?: string;
  matchReason?: string;
  transferCounterpartAccountId?: string;
}

export function buildMovementCompositeFingerprint(params: {
  institutionId?: string;
  institutionName?: string;
  targetAccountId?: string;
  date: string;
  amountCents: number;
  direction: string;
  movementType?: string;
  normalizedDescription: string;
  bankTransactionId?: string;
  currency?: string;
}): string {
  const parts = [
    (params.institutionId || params.institutionName || 'inst').toLowerCase(),
    params.targetAccountId || 'acc',
    params.date || 'no-date',
    String(Math.abs(params.amountCents || 0)),
    params.direction || 'EXPENSE',
    params.movementType || 'OUTRO',
    params.normalizedDescription || '',
    params.bankTransactionId || '',
    (params.currency || 'BRL').toUpperCase(),
  ];
  return `mfp-${computeFastHash(parts.join('|'))}`;
}

function diffDays(dateA: string, dateB: string): number {
  const a = new Date(`${dateA}T00:00:00Z`).getTime();
  const b = new Date(`${dateB}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 999;
  return Math.abs(Math.round((a - b) / 86_400_000));
}

function detectUpdatedSourceDiff(
  mov: {
    date: string;
    amountCents: number;
    normalizedDescription: string;
  },
  prev: {
    date: string;
    amountCents: number;
    description: string;
  }
): string[] {
  const diffs: string[] = [];
  if (prev.date !== mov.date) {
    diffs.push(`data (${prev.date} → ${mov.date})`);
  }
  if (prev.amountCents !== mov.amountCents) {
    diffs.push(`valor (${(prev.amountCents / 100).toFixed(2)} → ${(mov.amountCents / 100).toFixed(2)})`);
  }
  if (normalizeDescription(prev.description) !== mov.normalizedDescription) {
    diffs.push('descrição alterada na origem');
  }
  return diffs;
}

export function evaluateMovementDuplicates(params: {
  movement: Pick<
    ExtractedMovement,
    | 'id'
    | 'bankTransactionId'
    | 'compositeFingerprint'
    | 'date'
    | 'amountCents'
    | 'direction'
    | 'currency'
    | 'normalizedDescription'
    | 'operationType'
    | 'movementType'
    | 'counterparty'
    | 'targetAccountId'
    | 'targetCardId'
    | 'entityId'
    | 'cryptoMeta'
    | 'cardMeta'
  >;
  existingTransactions: Transaction[];
  previousBatches: ExtractionBatch[];
  batchSiblings: ExtractedMovement[];
  accounts: Account[];
}): DuplicateCheckResult {
  const { movement, existingTransactions, previousBatches, batchSiblings, accounts } = params;

  const activeTxs = existingTransactions.filter((t) => t.status !== 'CANCELLED');
  const normMovDesc = movement.normalizedDescription;

  // Guard: Invalid movement cannot be synced cleanly
  if (!movement.date || movement.amountCents <= 0 || !normMovDesc) {
    return {
      classification: 'INEDITA',
      layer: 'NONE',
      syncState: 'INVALID',
      duplicationConfidence: 0.2,
    };
  }

  // Level 1: Exact original bank transaction ID (FITID, E2E, NSU, txHash)
  const nativeId = movement.bankTransactionId || movement.cryptoMeta?.txHash;
  if (nativeId) {
    const exactTx = activeTxs.find(
      (t) =>
        t.externalId === nativeId &&
        (!movement.targetAccountId || !t.accountId || t.accountId === movement.targetAccountId)
    );
    if (exactTx) {
      const diffs = detectUpdatedSourceDiff(movement, {
        date: exactTx.date,
        amountCents: getTransactionAmountCents(exactTx),
        description: exactTx.originalDescription || exactTx.description,
      });
      if (diffs.length > 0) {
        return {
          classification: 'POSSIVEL_DUPLICIDADE',
          layer: 'EXATA',
          syncState: 'UPDATED_SOURCE',
          duplicationConfidence: 0.94,
          updatedSourceDiff: diffs,
          matchTxId: exactTx.id,
          matchReason: `Mesmo identificador bancário (${nativeId}), porém com alteração na origem: ${diffs.join(', ')}.`,
        };
      }
      return {
        classification: 'DUPLICIDADE_CONFIRMADA',
        layer: 'EXATA',
        syncState: 'EXISTING',
        duplicationConfidence: 0.99,
        matchTxId: exactTx.id,
        matchReason: `Mesmo identificador bancário (${nativeId}) já registrado no sistema.`,
      };
    }

    for (const batch of previousBatches) {
      if (batch.status === 'CANCELADO') continue;
      const prevMatch = batch.movements.find(
        (m) =>
          m.id !== movement.id &&
          m.reviewStatus !== 'IGNORADO' &&
          (m.bankTransactionId === nativeId || m.cryptoMeta?.txHash === nativeId)
      );
      if (prevMatch) {
        const diffs = detectUpdatedSourceDiff(movement, {
          date: prevMatch.date,
          amountCents: prevMatch.amountCents,
          description: prevMatch.originalDescription,
        });
        if (diffs.length > 0) {
          return {
            classification: 'POSSIVEL_DUPLICIDADE',
            layer: 'EXATA',
            syncState: 'UPDATED_SOURCE',
            duplicationConfidence: 0.93,
            updatedSourceDiff: diffs,
            matchBatchId: batch.id,
            matchReason: `ID (${nativeId}) encontrado em "${batch.fileName}" com atualização na origem: ${diffs.join(', ')}.`,
          };
        }
        return {
          classification: 'DUPLICIDADE_CONFIRMADA',
          layer: 'EXATA',
          syncState: 'EXISTING',
          duplicationConfidence: 0.98,
          matchBatchId: batch.id,
          matchReason: `Movimentação (${nativeId}) já extraída no lote "${batch.fileName}".`,
        };
      }
    }
  }

  // Level 1b: Composite deterministic fingerprint across previous uncancelled batches (same origin, account, date, amount, direction, type, description, currency)
  if (movement.compositeFingerprint) {
    for (const batch of previousBatches) {
      if (batch.status === 'CANCELADO') continue;
      const fpMatch = batch.movements.find(
        (m) =>
          m.id !== movement.id &&
          m.reviewStatus !== 'IGNORADO' &&
          m.compositeFingerprint &&
          m.compositeFingerprint === movement.compositeFingerprint
      );
      if (fpMatch) {
        return {
          classification: 'DUPLICIDADE_CONFIRMADA',
          layer: 'EXATA',
          syncState: 'EXISTING',
          duplicationConfidence: 0.95,
          matchBatchId: batch.id,
          matchReason: `Mesma assinatura composta já importada no lote "${batch.fileName}".`,
        };
      }
    }
  }

  // Level 2: Scheduled / Pending transaction match (reconcile rather than duplicate)
  if (movement.targetAccountId) {
    const scheduledMatch = findMatchingScheduledTransaction(
      {
        date: movement.date,
        amount: movement.amountCents / 100,
        amountCents: movement.amountCents,
        accountId: movement.targetAccountId,
        direction: movement.direction,
      },
      activeTxs
    );
    if (scheduledMatch) {
      return {
        classification: 'JA_REGISTRADA',
        layer: 'PROVAVEL',
        syncState: 'EXISTING',
        duplicationConfidence: 0.9,
        matchTxId: scheduledMatch.id,
        matchReason: `Concilia com lançamento ${scheduledMatch.status === 'PENDING' ? 'Pendente' : 'Planejado'}: "${scheduledMatch.description}".`,
      };
    }
  }

  // Level 3: Confirmed existing transaction with same account + date + amount + normalized description/counterparty
  // Note: NEVER auto-delete solely on date + amount!
  for (const tx of activeTxs) {
    if (tx.direction !== movement.direction) continue;
    if (movement.targetAccountId && tx.accountId && tx.accountId !== movement.targetAccountId) {
      continue;
    }
    if (getTransactionAmountCents(tx) !== movement.amountCents) continue;
    if (diffDays(tx.date, movement.date) > 1) continue;

    const txNorm = normalizeDescription(tx.description);
    const sameDesc =
      txNorm === normMovDesc ||
      (txNorm.length >= 6 && normMovDesc.includes(txNorm)) ||
      (normMovDesc.length >= 6 && txNorm.includes(normMovDesc));
    const sameCounterparty = Boolean(
      movement.counterparty &&
        tx.counterparty &&
        normalizeDescription(movement.counterparty) === normalizeDescription(tx.counterparty)
    );

    if (sameDesc || sameCounterparty) {
      const isManual = tx.origin === 'MANUAL';
      return {
        classification: isManual ? 'JA_REGISTRADA' : 'POSSIVEL_DUPLICIDADE',
        layer: 'PROVAVEL',
        syncState: isManual ? 'EXISTING' : 'POSSIBLE_DUPLICATE',
        duplicationConfidence: sameDesc ? 0.87 : 0.78,
        matchTxId: tx.id,
        matchReason: isManual
          ? `Lançamento manual equivalente já existe em ${tx.date} ("${tx.description}").`
          : `Duplicidade provável com "${tx.description}" (${tx.date}).`,
      };
    }
  }

  // Level 4: Related Movements (NEVER auto-delete!)
  // 4a: Purchase & Reversal (Compra e Estorno)
  if (movement.movementType === 'ESTORNO' || /\bestorno\b|\bchargeback\b|\breembolso\b|\bdevolucao\b/.test(normMovDesc)) {
    const oppositeTx = activeTxs.find(
      (tx) =>
        tx.direction === 'EXPENSE' &&
        getTransactionAmountCents(tx) === movement.amountCents &&
        diffDays(tx.date, movement.date) <= 30 &&
        (!movement.targetAccountId || !tx.accountId || tx.accountId === movement.targetAccountId)
    );
    const siblingPurchase = batchSiblings.find(
      (s) =>
        s.id !== movement.id &&
        s.direction === 'EXPENSE' &&
        s.amountCents === movement.amountCents &&
        diffDays(s.date, movement.date) <= 30
    );
    if (oppositeTx || siblingPurchase) {
      return {
        classification: 'RELACIONADA',
        layer: 'RELACIONADA',
        relatedKind: 'COMPRA_E_ESTORNO',
        syncState: 'NEW',
        duplicationConfidence: 0.88,
        matchTxId: oppositeTx?.id,
        matchReason: oppositeTx
          ? `Estorno relacionado à compra "${oppositeTx.description}" (${oppositeTx.date}). Mantido separadamente.`
          : `Estorno relacionado à compra "${siblingPurchase!.originalDescription}" no mesmo lote.`,
      };
    }
  }

  // 4b: Card Invoice Payment & Settlement (Pagamento e Baixa de Fatura)
  if (movement.movementType === 'FATURA_CARTAO' || /pagamento\s*(?:de\s*)?fatura|pgto\s*fatura/.test(normMovDesc)) {
    return {
      classification: 'RELACIONADA',
      layer: 'RELACIONADA',
      relatedKind: 'PAGAMENTO_E_BAIXA_FATURA',
      syncState: 'NEW',
      duplicationConfidence: 0.86,
      matchReason: 'Pagamento de fatura de cartão relacionado à baixa de obrigação — não contabilizar em duplicidade com compras.',
    };
  }

  // 4c: Balance adjustment (Ajuste de saldo)
  if (/ajuste\s*(?:de\s*)?saldo|acerto\s*saldo|estorno\s*tarifa\s*ajuste/.test(normMovDesc)) {
    return {
      classification: 'RELACIONADA',
      layer: 'RELACIONADA',
      relatedKind: 'AJUSTE_SALDO',
      syncState: 'NEEDS_REVIEW',
      duplicationConfidence: 0.8,
      matchReason: 'Movimentação identificada como ajuste de saldo — revise vínculo antes de aprovar.',
    };
  }

  // 4d: Installment Purchase check against already projected/imported installment
  if (movement.cardMeta?.installmentTotal && movement.cardMeta.installmentTotal > 1) {
    const dupInstallment = activeTxs.find(
      (tx) =>
        tx.installmentTotal === movement.cardMeta?.installmentTotal &&
        tx.installmentCurrent === movement.cardMeta?.installmentCurrent &&
        getTransactionAmountCents(tx) === movement.amountCents &&
        (!movement.targetCardId || tx.creditCardId === movement.targetCardId)
    );
    if (dupInstallment) {
      return {
        classification: 'POSSIVEL_DUPLICIDADE',
        layer: 'PROVAVEL',
        relatedKind: 'COMPRA_PARCELADA',
        syncState: 'POSSIBLE_DUPLICATE',
        duplicationConfidence: 0.91,
        matchTxId: dupInstallment.id,
        matchReason: `Parcela ${movement.cardMeta.installmentCurrent}/${movement.cardMeta.installmentTotal} já projetada/importada em "${dupInstallment.description}".`,
      };
    }
  }

  // 4e: Own-account internal transfer detection (opposite direction, same amount within 2 days)
  const targetAcc = accounts.find((a) => a.id === movement.targetAccountId);
  const effectiveEntity = movement.entityId || targetAcc?.entityId;
  const oppositeDirection = movement.direction === 'INCOME' ? 'EXPENSE' : 'INCOME';
  const isTransferLike =
    movement.movementType === 'TRANSFERENCIA' ||
    movement.movementType === 'PIX_ENVIADO' ||
    movement.movementType === 'PIX_RECEBIDO' ||
    movement.operationType === 'TRANSFERENCIA_PROPRIA' ||
    movement.operationType === 'PIX' ||
    movement.operationType === 'TED_DOC';

  const ownCounterpartTx = activeTxs.find((tx) => {
    if (tx.direction !== oppositeDirection) return false;
    if (!tx.accountId || tx.accountId === movement.targetAccountId) return false;
    if (getTransactionAmountCents(tx) !== movement.amountCents) return false;
    if (diffDays(tx.date, movement.date) > 2) return false;
    const txTransferLike =
      tx.operationType === 'TRANSFERENCIA_PROPRIA' ||
      tx.operationType === 'PIX' ||
      tx.operationType === 'TED_DOC';
    if (!isTransferLike && !txTransferLike) return false;

    if (!effectiveEntity || tx.entityId === effectiveEntity) return true;
    const otherAcc = accounts.find((a) => a.id === tx.accountId);
    const sameBank =
      Boolean(targetAcc && otherAcc) &&
      targetAcc!.institutionName.toLowerCase() === otherAcc!.institutionName.toLowerCase();
    return sameBank || /mesma\s*titularidade|aporte|nubank|pix|ted/i.test(`${normMovDesc} ${tx.description}`);
  });

  if (ownCounterpartTx) {
    const crossEntity = Boolean(effectiveEntity && ownCounterpartTx.entityId !== effectiveEntity);
    return {
      classification: 'TRANSFERENCIA_PROPRIA',
      layer: 'RELACIONADA',
      relatedKind: 'TRANSFERENCIA_PROPRIA',
      syncState: 'NEW',
      duplicationConfidence: 0.9,
      matchTxId: ownCounterpartTx.id,
      transferCounterpartAccountId: ownCounterpartTx.accountId,
      matchReason: crossEntity
        ? `Transferência entre contas próprias (${effectiveEntity} ↔ ${ownCounterpartTx.entityId}) relacionada a "${ownCounterpartTx.account}".`
        : `Possível transferência entre contas próprias relacionada à movimentação em "${ownCounterpartTx.account}".`,
    };
  }

  for (const batch of previousBatches) {
    if (batch.status === 'CANCELADO') continue;
    const batchCounterpartAccId = batch.confirmedAccountId || batch.identifiedAccount.matchedAccountId;
    if (!batchCounterpartAccId || batchCounterpartAccId === movement.targetAccountId) continue;

    const matchMov = batch.movements.find((m) => {
      if (m.reviewStatus === 'IGNORADO') return false;
      if (m.direction !== oppositeDirection) return false;
      if (m.amountCents !== movement.amountCents) return false;
      if (diffDays(m.date, movement.date) > 2) return false;
      const mTransferLike =
        m.movementType === 'TRANSFERENCIA' ||
        m.movementType === 'PIX_ENVIADO' ||
        m.movementType === 'PIX_RECEBIDO' ||
        m.operationType === 'TRANSFERENCIA_PROPRIA' ||
        m.operationType === 'PIX' ||
        m.operationType === 'TED_DOC';
      return isTransferLike || mTransferLike;
    });

    if (matchMov) {
      const otherAcc = accounts.find((a) => a.id === batchCounterpartAccId);
      const otherEntity = matchMov.entityId || otherAcc?.entityId;
      const crossEntity = Boolean(effectiveEntity && otherEntity && otherEntity !== effectiveEntity);
      return {
        classification: 'TRANSFERENCIA_PROPRIA',
        layer: 'RELACIONADA',
        relatedKind: 'TRANSFERENCIA_PROPRIA',
        syncState: 'NEW',
        duplicationConfidence: 0.88,
        matchBatchId: batch.id,
        transferCounterpartAccountId: batchCounterpartAccId,
        matchReason: crossEntity
          ? `Transferência entre contas próprias (${effectiveEntity} ↔ ${otherEntity}) detectada com o lote "${batch.fileName}".`
          : `Transferência entre contas próprias detectada com o lote "${batch.fileName}".`,
      };
    }
  }

  // 4f: Corresponding credit/debit on same day & amount (opposite direction, non-transfer)
  const correspondingOpposite = batchSiblings.find(
    (s) =>
      s.id !== movement.id &&
      s.date === movement.date &&
      s.amountCents === movement.amountCents &&
      s.direction === oppositeDirection
  );
  if (correspondingOpposite) {
    return {
      classification: 'RELACIONADA',
      layer: 'RELACIONADA',
      relatedKind: 'CREDITO_DEBITO_CORRESPONDENTE',
      syncState: 'NEEDS_REVIEW',
      duplicationConfidence: 0.72,
      matchReason: `Crédito e débito correspondentes de mesmo valor em ${movement.date} ("${correspondingOpposite.originalDescription}").`,
    };
  }

  // Level 5: Probable or Suspect duplicates across previous batches or within same batch
  for (const batch of previousBatches) {
    if (batch.status === 'CANCELADO') continue;
    const batchMatch = batch.movements.find(
      (m) =>
        m.id !== movement.id &&
        m.reviewStatus !== 'IGNORADO' &&
        m.date === movement.date &&
        m.amountCents === movement.amountCents &&
        m.direction === movement.direction &&
        m.normalizedDescription === normMovDesc &&
        (!movement.targetAccountId || !m.targetAccountId || m.targetAccountId === movement.targetAccountId)
    );
    if (batchMatch) {
      return {
        classification: 'POSSIVEL_DUPLICIDADE',
        layer: 'PROVAVEL',
        syncState: 'POSSIBLE_DUPLICATE',
        duplicationConfidence: 0.84,
        matchBatchId: batch.id,
        matchReason: `Item semelhante encontrado na extração anterior "${batch.fileName}".`,
      };
    }

    // Suspect match: same day & amount in same account, different description
    const suspectPrev = batch.movements.find(
      (m) =>
        m.id !== movement.id &&
        m.reviewStatus !== 'IGNORADO' &&
        m.date === movement.date &&
        m.amountCents === movement.amountCents &&
        m.direction === movement.direction &&
        m.normalizedDescription !== normMovDesc &&
        (!movement.targetAccountId || !m.targetAccountId || m.targetAccountId === movement.targetAccountId)
    );
    if (suspectPrev) {
      return {
        classification: 'POSSIVEL_DUPLICIDADE',
        layer: 'SUSPEITA',
        relatedKind: 'COMPRA_REPETIDA_ESTABELECIMENTO',
        syncState: 'POSSIBLE_DUPLICATE',
        duplicationConfidence: 0.56,
        matchBatchId: batch.id,
        matchReason: `Movimentação suspeita de mesmo valor e data no lote "${batch.fileName}" ("${suspectPrev.originalDescription}"). Nunca excluída automaticamente.`,
      };
    }
  }

  // Also flag identical lines within the same file (except if bank IDs explicitly differ)
  const siblingMatch = batchSiblings.find(
    (s) =>
      s.id !== movement.id &&
      s.date === movement.date &&
      s.amountCents === movement.amountCents &&
      s.direction === movement.direction &&
      s.normalizedDescription === normMovDesc &&
      (!s.bankTransactionId || !movement.bankTransactionId || s.bankTransactionId === movement.bankTransactionId)
  );
  if (siblingMatch) {
    return {
      classification: 'POSSIVEL_DUPLICIDADE',
      layer: 'SUSPEITA',
      relatedKind: 'COMPRA_REPETIDA_ESTABELECIMENTO',
      syncState: 'POSSIBLE_DUPLICATE',
      duplicationConfidence: 0.62,
      matchReason:
        'Compra repetida ou linha idêntica no mesmo arquivo; verifique se são duas compras reais no mesmo estabelecimento.',
    };
  }

  return {
    classification: 'INEDITA',
    layer: 'NONE',
    syncState: 'NEW',
    duplicationConfidence: 0.96,
  };
}

