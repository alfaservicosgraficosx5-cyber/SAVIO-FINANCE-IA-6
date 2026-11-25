import { describe, expect, it } from 'vitest';
import type { CategoryRule, CreditCard, Transaction } from '../../types';
import {
  buildImportedCardTransactions,
  buildLearnedClassificationRules,
  detectInvoiceInstallment,
  importCardStatement,
  parseBrazilianCardInvoiceCsv,
  parseBrazilianCardInvoiceOfx,
  parseBrazilianCardInvoicePdfText,
  shouldIgnoreInvoiceAccountingLine,
} from '../../services/statementImporter';
import { computeCardImportHash } from '../../domain/cards/cardImportHash';
import { calculateConfirmedExpenseCents } from '../../domain/accounts/BalanceCalculator';
import { consolidateFinance } from '../../domain/finance/FinanceConsolidationService';
import { cents } from '../../domain/money/money';

const sampleCard: CreditCard = {
  id: 'card-nubank-1',
  entityId: 'CPF',
  institutionName: 'Nubank',
  bankCode: '260',
  cardName: 'Ultravioleta',
  last4: '9912',
  limit: 20000,
  closingDay: 10,
  dueDay: 17,
  currentInvoiceAmount: 0,
  status: 'OPEN',
};

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('statementImporter — Automação de Faturas, Parcelas, SHA-256 & Regras CPF/CNPJ', () => {
  it('filtra Pagamento de fatura / Crédito em fatura e preserva IOF/estornos', () => {
    expect(shouldIgnoreInvoiceAccountingLine('Pagamento de fatura')).toBe(true);
    expect(shouldIgnoreInvoiceAccountingLine('PGTO DE FATURA RECEBIDO')).toBe(true);
    expect(shouldIgnoreInvoiceAccountingLine('Crédito em fatura')).toBe(true);
    expect(shouldIgnoreInvoiceAccountingLine('Saldo anterior')).toBe(true);
    expect(shouldIgnoreInvoiceAccountingLine('Limite disponível')).toBe(true);

    expect(shouldIgnoreInvoiceAccountingLine('IOF COMPRA INTERNACIONAL')).toBe(false);
    expect(shouldIgnoreInvoiceAccountingLine('ESTORNO MERCADO LIVRE')).toBe(false);
    expect(shouldIgnoreInvoiceAccountingLine('UBER *TRIP')).toBe(false);
  });

  it('detecta parcelas nos formatos 03/10, 3 de 10 e PARC 02/12 sem confundir datas', () => {
    const a = detectInvoiceInstallment('MAGALU LOJA X 03/10');
    expect(a.tipo).toBe('parcelada');
    expect(a.installmentCurrent).toBe(3);
    expect(a.installmentTotal).toBe(10);
    expect(a.cleanDescription).toBe('MAGALU LOJA X');

    const b = detectInvoiceInstallment('DELL COMPUTADORES PARC 2 DE 6');
    expect(b.tipo).toBe('parcelada');
    expect(b.installmentCurrent).toBe(2);
    expect(b.installmentTotal).toBe(6);

    const c = detectInvoiceInstallment('COMPRA 14/05/2026 PADARIA');
    expect(c.tipo).toBe('avista');
    expect(c.installmentCurrent).toBe(1);
    expect(c.installmentTotal).toBe(1);
  });

  it('lê CSV de bancos brasileiros (Nubank/Itaú/Inter) e projeta parcelas futuras respeitando fechamento e vencimento', async () => {
    const csv = [
      'date,category,title,amount',
      '2026-04-02,transporte,Uber *Trip,34.50',
      '2026-04-05,eletronicos,Kabum Hardware 02/05,300.00',
      '2026-04-06,outros,Pagamento de fatura,-1200.00',
      '2026-04-08,servicos,Estorno Loja Teste,-45.00',
    ].join('\n');

    const rules: CategoryRule[] = [
      {
        id: 'rule-kabum',
        keyword: 'Kabum',
        category: 'Insumos / Produção',
        category_id: 'Insumos / Produção',
        profile: 'CNPJ',
        entityId: 'CNPJ',
        card_id: sampleCard.id,
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    ];

    const preview = await importCardStatement({
      fileName: 'fatura_nubank_2026_04.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(csv),
      card: sampleCard,
      existingTransactions: [],
      classificationRules: rules,
      allowAiFallback: false,
    });

    expect(preview.parseEngine).toBe('LOCAL_CSV');
    expect(preview.ignoredAccountingLinesCount).toBe(1);
    expect(preview.rows).toHaveLength(3);
    expect(preview.newRowsCount).toBe(3);
    // Kabum 02/05 -> 3 parcelas futuras (03/05, 04/05, 05/05)
    expect(preview.projectedFutureInstallmentsCount).toBe(3);

    const kabumRow = preview.rows.find((r) => r.cleanDescription.includes('Kabum'))!;
    expect(kabumRow.category).toBe('Insumos / Produção');
    expect(kabumRow.profile).toBe('CNPJ');
    expect(kabumRow.installmentCurrent).toBe(2);
    expect(kabumRow.installmentTotal).toBe(5);
    expect(kabumRow.import_hash).toHaveLength(64);

    const txsToSave = buildImportedCardTransactions({
      rows: preview.rows,
      targetCard: sampleCard,
      importBatchId: 'batch-1',
      generateFutureInstallments: true,
      existingTransactions: [],
    });

    // 3 atuais (CONFIRMED) + 3 futuras Kabum (PENDING) = 6
    expect(txsToSave).toHaveLength(6);
    const futureKabum = txsToSave.filter((t) => t.status === 'PENDING');
    expect(futureKabum.map((f) => f.installmentCurrent)).toEqual([3, 4, 5]);
    expect(futureKabum.every((f) => f.entityId === 'CNPJ')).toBe(true);
    expect(futureKabum[0].billingCycleYm).toBe('2026-05');
    expect(futureKabum[0].billingDueDate).toBe('2026-05-17');
  });

  it('bloqueia duplicidades pelo import_hash SHA-256 ao reimportar a mesma fatura', async () => {
    const csv = [
      'Data;Lançamento;Valor',
      '05/04/2026;IFOOD *MERCADO;89,90',
      '06/04/2026;AMAZON BR 01/03;100,00',
    ].join('\n');

    const existingHash = computeCardImportHash({
      cardId: sampleCard.id,
      date: '2026-04-05',
      amountCents: 8990,
      cleanDescription: 'IFOOD *MERCADO',
      direction: 'EXPENSE',
    });

    const existingTx: Transaction = {
      id: 'tx-existing-1',
      entityId: 'CPF',
      accountId: sampleCard.id,
      creditCardId: sampleCard.id,
      date: '2026-04-05',
      description: 'IFOOD *MERCADO',
      category: 'Alimentação',
      account: 'Nubank · Ultravioleta',
      amount: 89.9,
      amountCents: cents(8990),
      direction: 'EXPENSE',
      status: 'CONFIRMED',
      origin: 'IMPORT',
      import_hash: existingHash,
    };

    const preview = await importCardStatement({
      fileName: 'fatura_itau.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(csv),
      card: sampleCard,
      existingTransactions: [existingTx],
      classificationRules: [],
      allowAiFallback: false,
    });

    expect(preview.ignoredDuplicatesCount).toBe(1);
    expect(preview.newRowsCount).toBe(1);
    expect(preview.rows[0].alreadyImported).toBe(true);
    expect(preview.rows[0].selected).toBe(false);
    expect(preview.rows[1].alreadyImported).toBe(false);
    expect(preview.rows[1].selected).toBe(true);

    const txsToSave = buildImportedCardTransactions({
      rows: preview.rows,
      targetCard: sampleCard,
      importBatchId: 'batch-dup-check',
      generateFutureInstallments: false,
      existingTransactions: [existingTx],
    });
    expect(txsToSave).toHaveLength(1);
    expect(txsToSave[0].description).toContain('AMAZON BR');
  });

  it('lê OFX de cartão (<CCSTMTRS>) e texto extraído de PDF brasileiro (Nubank/Bradesco/Sicoob/Sicredi)', () => {
    const sampleOfx = [
      '<OFX>',
      '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
      '<CURDEF>BRL',
      '<CCACCTFROM><ACCTID>9912</CCACCTFROM>',
      '<BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260403120000<TRNAMT>-120.50<FITID>FIT-1<MEMO>DROGASIL 01/02</STMTTRN>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260404120000<TRNAMT>950.00<FITID>FIT-2<MEMO>PAGAMENTO DE FATURA</STMTTRN>',
      '</BANKTRANLIST>',
      '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
      '</OFX>',
    ].join('\n');

    const ofxParsed = parseBrazilianCardInvoiceOfx(sampleOfx, 'fatura_sicoob.ofx');
    expect(ofxParsed.ignoredAccountingLinesCount).toBe(1);
    expect(ofxParsed.items).toHaveLength(1);
    expect(ofxParsed.items[0].amount).toBe(120.5);

    const pdfSample = [
      'NUBANK FATURA MENSAL',
      'Vencimento: 17/04/2026',
      'Total da fatura: R$ 459,90',
      '02 ABR   SUPERMERCADO EXTRA      R$ 159,90',
      '05 ABR   LOJAS RENNER 02/04      300,00',
      '06 ABR   PAGAMENTO DE FATURA     -1.000,00',
    ].join('\n');

    const pdfParsed = parseBrazilianCardInvoicePdfText(pdfSample, 'nubank_abril.pdf');
    expect(pdfParsed.dueDate).toBe('2026-04-17');
    expect(pdfParsed.ignoredAccountingLinesCount).toBe(1);
    expect(pdfParsed.items).toHaveLength(2);
    expect(pdfParsed.items[0].date).toBe('2026-04-02');
    expect(pdfParsed.items[0].amount).toBe(159.9);
    expect(pdfParsed.items[1].description).toContain('02/04');
  });

  it('aprende classification_rules ao confirmar e mantém pagamento de fatura neutro nas despesas consolidadas', () => {
    const csvParsed = parseBrazilianCardInvoiceCsv(
      'Data;Estabelecimento;Valor\n02/04/2026;KALUNGA COMERCIO;210,00',
      'fatura.csv'
    );
    expect(csvParsed.items).toHaveLength(1);

    const learned = buildLearnedClassificationRules({
      rows: [
        {
          cleanDescription: 'KALUNGA COMERCIO',
          description: 'KALUNGA COMERCIO',
          category: 'Insumos / Produção',
          profile: 'CNPJ',
          direction: 'EXPENSE',
          selected: true,
          alreadyImported: false,
        },
      ],
      cardId: sampleCard.id,
      existingRules: [],
    });

    expect(learned).toHaveLength(1);
    expect(learned[0].profile).toBe('CNPJ');
    expect(learned[0].category_id).toBe('Insumos / Produção');
    expect(learned[0].card_id).toBe(sampleCard.id);

    // Conciliação de pagamento: compra no cartão (R$ 210) + pagamento da fatura pela conta bancária (R$ 210)
    // não pode dobrar despesa no Consolidado!
    const txs: Transaction[] = [
      {
        id: 'tx-compra-1',
        entityId: 'CNPJ',
        accountId: sampleCard.id,
        creditCardId: sampleCard.id,
        date: '2026-04-02',
        description: 'KALUNGA COMERCIO',
        category: 'Insumos / Produção',
        account: 'Nubank · Ultravioleta',
        amount: 210,
        amountCents: cents(21000),
        direction: 'EXPENSE',
        status: 'CONFIRMED',
        origin: 'IMPORT',
      },
      {
        id: 'tx-pgto-1',
        entityId: 'CNPJ',
        accountId: 'acc-bb-pj',
        creditCardId: sampleCard.id,
        date: '2026-04-17',
        description: 'Pgto Fatura: Ultravioleta',
        category: 'Cartão',
        account: 'Banco do Brasil · PJ',
        amount: 210,
        amountCents: cents(21000),
        direction: 'EXPENSE',
        status: 'CONFIRMED',
        origin: 'MANUAL',
        isCardBillPayment: true,
        isInternalTransfer: true,
      },
    ];

    expect(calculateConfirmedExpenseCents(txs)).toBe(cents(21000));
    const consolidated = consolidateFinance({
      accounts: [
        {
          id: 'acc-bb-pj',
          entityId: 'CNPJ',
          institutionName: 'Banco do Brasil',
          accountName: 'Conta PJ',
          accountType: 'business',
          openingBalance: 1000,
          openingBalanceCents: cents(100000),
          balance: 1000,
          balanceCents: cents(100000),
        },
      ],
      creditCards: [sampleCard],
      transactions: txs,
      boletos: [],
      debts: [],
      assets: [],
      scope: 'CONSOLIDATED',
    });
    expect(consolidated.summary.totalExpenses).toBe(210);
    expect(consolidated.summary.consolidatedBalance).toBe(790);
  });
});
