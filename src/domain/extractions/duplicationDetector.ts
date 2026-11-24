import type { Account, Transaction } from '../../types';
import type {
  DuplicateClassification,
  ExtractedMovement,
  ExtractionBatch,
} from '../../types-sub/extractions';
import { getTransactionAmountCents, normalizeDescription } from '../../utils/financeCalculations';
import { findMatchingScheduledTransaction } from '../transactions/ImportReconciliationService';

export interface DuplicateCheckResult {
  classification: DuplicateClassification;
  matchTxId?: string;
  matchBatchId?: string;
  matchReason?: string;
  transferCounterpartAccountId?: string;
}

function diffDays(dateA: string, dateB: string): number {
  const a = new Date(`${dateA}T00:00:00Z`).getTime();
  const b = new Date(`${dateB}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 999;
  return Math.abs(Math.round((a - b) / 86_400_000));
}

export function evaluateMovementDuplicates(params: {
  movement: Pick<
    ExtractedMovement,
    | 'id'
    | 'bankTransactionId'
    | 'date'
    | 'amountCents'
    | 'direction'
    | 'normalizedDescription'
    | 'operationType'
    | 'movementType'
    | 'counterparty'
    | 'targetAccountId'
    | 'entityId'
    | 'cryptoMeta'
  >;
  existingTransactions: Transaction[];
  previousBatches: ExtractionBatch[];
  batchSiblings: ExtractedMovement[];
  accounts: Account[];
}): DuplicateCheckResult {
  const { movement, existingTransactions, previousBatches, batchSiblings, accounts } = params;

  const activeTxs = existingTransactions.filter((t) => t.status !== 'CANCELLED');

  // Level 1: Exact original bank transaction ID (FITID, E2E, NSU, txHash)
  const nativeId = movement.bankTransactionId || movement.cryptoMeta?.txHash;
  if (nativeId) {
    const exactTx = activeTxs.find(
      (t) =>
        t.externalId === nativeId &&
        (!movement.targetAccountId || !t.accountId || t.accountId === movement.targetAccountId)
    );
    if (exactTx) {
      return {
        classification: 'DUPLICIDADE_CONFIRMADA',
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
        return {
          classification: 'DUPLICIDADE_CONFIRMADA',
          matchBatchId: batch.id,
          matchReason: `Movimentação (${nativeId}) já extraída no lote "${batch.fileName}".`,
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
        matchTxId: scheduledMatch.id,
        matchReason: `Concilia com lançamento ${scheduledMatch.status === 'PENDING' ? 'Pendente' : 'Planejado'}: "${scheduledMatch.description}".`,
      };
    }
  }

  // Level 3: Confirmed existing transaction with same account + date + amount + normalized description
  // Note: NEVER discard solely on date + amount! Require normalized description similarity or same counterparty/op.
  const normMovDesc = movement.normalizedDescription;
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
      return {
        classification:
          tx.origin === 'MANUAL' ? 'JA_REGISTRADA' : 'POSSIVEL_DUPLICIDADE',
        matchTxId: tx.id,
        matchReason:
          tx.origin === 'MANUAL'
            ? `Lançamento manual equivalente já existe em ${tx.date} ("${tx.description}").`
            : `Possível duplicidade com "${tx.description}" (${tx.date}).`,
      };
    }
  }

  // Level 4: Own-account internal transfer detection (opposite direction, same amount within 2 days, across transactions or previous batches)
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

  // Check existing transactions on other user accounts
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
    // Allow PF <-> PJ link when same-bank or explicit transfer/aporte/mesma titularidade/nubank cue
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
      matchTxId: ownCounterpartTx.id,
      transferCounterpartAccountId: ownCounterpartTx.accountId,
      matchReason: crossEntity
        ? `Transferência entre contas próprias (${effectiveEntity} ↔ ${ownCounterpartTx.entityId}) relacionada a "${ownCounterpartTx.account}".`
        : `Possível transferência entre contas próprias relacionada à movimentação em "${ownCounterpartTx.account}".`,
    };
  }

  // Also check previous uncancelled batches on a different account for opposite-side counterpart
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
        matchBatchId: batch.id,
        transferCounterpartAccountId: batchCounterpartAccId,
        matchReason: crossEntity
          ? `Transferência entre contas próprias (${effectiveEntity} ↔ ${otherEntity}) detectada com o lote "${batch.fileName}".`
          : `Transferência entre contas próprias detectada com o lote "${batch.fileName}".`,
      };
    }
  }

  // Level 5: Duplicate inside previous uncancelled extraction batches (same account + date + amount + desc)
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
        matchBatchId: batch.id,
        matchReason: `Item semelhante encontrado na extração anterior "${batch.fileName}".`,
      };
    }
  }

  // Also flag identical lines within the same file (except if bank IDs differ)
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
      matchReason: 'Linha idêntica repetida no mesmo arquivo; verifique se são duas compras reais ou repetição.',
    };
  }

  return { classification: 'INEDITA' };
}
