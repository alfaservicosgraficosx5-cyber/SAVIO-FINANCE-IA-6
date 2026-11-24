import { cents, addMoney, subtractMoney } from '../money/money';
import type { MoneyCents } from '../money/money';
import type { ExtractedMovement, StatementBalanceSummary } from '../../types-sub/extractions';

export function computeStatementBalanceSummary(params: {
  movements: ExtractedMovement[];
  openingBalanceCents?: MoneyCents;
  reportedEndingBalanceCents?: MoneyCents;
  availableBalanceCents?: MoneyCents;
  blockedBalanceCents?: MoneyCents;
}): StatementBalanceSummary {
  const {
    movements,
    openingBalanceCents,
    reportedEndingBalanceCents,
    availableBalanceCents,
    blockedBalanceCents,
  } = params;

  let creditsCents = cents(0);
  let debitsCents = cents(0);
  let operationalIncomeCents = cents(0);
  let operationalExpenseCents = cents(0);
  let internalTransfersCents = cents(0);
  let applicationsCents = cents(0);
  let redemptionsCents = cents(0);
  let yieldsCents = cents(0);
  let cashbackCents = cents(0);
  let reversalsCents = cents(0);
  let movementCount = 0;
  let unclassifiedCount = 0;
  const notes: string[] = [];

  for (const m of movements) {
    if (m.reviewStatus === 'IGNORADO' || m.reviewStatus === 'DUPLICIDADE') continue;
    movementCount += 1;

    if (m.movementType === 'NAO_IDENTIFICADO' || m.reviewStatus === 'PRECISA_IDENTIFICACAO') {
      unclassifiedCount += 1;
    }

    if (m.movementType === 'APLICACAO' || m.movementType === 'COMPRA_ATIVO') {
      applicationsCents = addMoney(applicationsCents, m.amountCents);
      if (m.direction === 'EXPENSE') {
        debitsCents = addMoney(debitsCents, m.amountCents);
      }
      continue;
    }

    if (m.movementType === 'RESGATE' || m.movementType === 'VENDA_ATIVO') {
      redemptionsCents = addMoney(redemptionsCents, m.amountCents);
      if (m.direction === 'INCOME') {
        creditsCents = addMoney(creditsCents, m.amountCents);
      }
      continue;
    }

    const isInternalTransfer =
      m.movementType === 'TRANSFERENCIA' ||
      m.duplicateStatus === 'TRANSFERENCIA_PROPRIA' ||
      m.operationType === 'TRANSFERENCIA_PROPRIA';

    if (isInternalTransfer) {
      internalTransfersCents = addMoney(internalTransfersCents, m.amountCents);
    } else if (m.movementType === 'RENDIMENTO' || m.movementType === 'PROVENTO') {
      yieldsCents = addMoney(yieldsCents, m.amountCents);
    } else if (m.movementType === 'CASHBACK') {
      cashbackCents = addMoney(cashbackCents, m.amountCents);
    } else if (m.movementType === 'ESTORNO') {
      reversalsCents = addMoney(reversalsCents, m.amountCents);
    } else if (m.movementType === 'FATURA_CARTAO') {
      // Invoice settlement decreases cash balance without inflating operational expense
    } else if (m.direction === 'INCOME') {
      operationalIncomeCents = addMoney(operationalIncomeCents, m.amountCents);
    } else {
      operationalExpenseCents = addMoney(operationalExpenseCents, m.amountCents);
    }

    if (m.direction === 'INCOME') {
      creditsCents = addMoney(creditsCents, m.amountCents);
    } else {
      debitsCents = addMoney(debitsCents, m.amountCents);
    }
  }

  const netResultCents = subtractMoney(creditsCents, debitsCents);

  let calculatedEndingBalanceCents: MoneyCents | undefined;
  let divergenceCents: MoneyCents | undefined;
  let hasDivergence = false;

  if (openingBalanceCents !== undefined) {
    calculatedEndingBalanceCents = subtractMoney(
      addMoney(openingBalanceCents, creditsCents),
      debitsCents
    );

    if (reportedEndingBalanceCents !== undefined) {
      const rawDiff = calculatedEndingBalanceCents - reportedEndingBalanceCents;
      divergenceCents = cents(Math.abs(rawDiff));
      hasDivergence = Math.abs(rawDiff) > 1; // 1 cent tolerance for bank rounding

      if (hasDivergence) {
        if (
          availableBalanceCents !== undefined &&
          Math.abs(calculatedEndingBalanceCents - availableBalanceCents) <= 1
        ) {
          notes.push(
            'Saldo calculado coincide com o saldo disponível; diferença em relação ao saldo contábil pode ser valor bloqueado/a compensar.'
          );
        } else {
          notes.push(
            `Divergência matemática de ${(Math.abs(rawDiff) / 100).toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })} entre o saldo calculado e o saldo final informado pelo banco. O saldo do sistema NÃO foi alterado automaticamente.`
          );
        }
      }
    }
  } else if (reportedEndingBalanceCents !== undefined) {
    notes.push(
      'Saldo inicial não constava no documento; informe o saldo inicial para validar a conciliação matemática completa.'
    );
  }

  if (applicationsCents > 0 || redemptionsCents > 0) {
    notes.push(
      'Aplicações e resgates estão contabilizados separadamente de receitas e despesas operacionais.'
    );
  }
  if (internalTransfersCents > 0) {
    notes.push(
      'Transferências internas/próprias foram separadas das receitas e despesas operacionais para evitar duplicação consolidada.'
    );
  }
  if (unclassifiedCount > 0) {
    notes.push(
      `${unclassifiedCount} movimentação(ões) aguardam identificação ou confirmação manual antes da efetivação.`
    );
  }

  return {
    openingBalanceCents,
    reportedEndingBalanceCents,
    availableBalanceCents,
    blockedBalanceCents,
    creditsCents,
    debitsCents,
    netResultCents,
    operationalIncomeCents,
    operationalExpenseCents,
    internalTransfersCents,
    applicationsCents,
    redemptionsCents,
    yieldsCents,
    cashbackCents,
    reversalsCents,
    movementCount,
    unclassifiedCount,
    calculatedEndingBalanceCents,
    divergenceCents,
    hasDivergence,
    notes,
  };
}
