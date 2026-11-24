import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { cents } from '../../money/money';
import { parseCsvStatement } from '../parsers/csvParser';
import { parseSpreadsheetStatement } from '../parsers/xlsxParser';
import { parseOfxStatement } from '../parsers/ofxParser';
import { parseTextualPdfContent } from '../parsers/pdfAndImageParser';
import { buildExtractionBatchFromParseResult } from '../extractionOrchestrator';
import { classifyExtractedMovement } from '../movementClassifier';
import { computeUniversalPeriodConsolidation } from '../consolidationEngine';
import { BUILTIN_INSTITUTIONS } from '../institutionRegistry';
import { identifySourceAccount } from '../accountIdentifier';
import type { Account, Transaction } from '../../../types';
import type { AccountExtensionMeta, ExtractionRule } from '../../../types-sub/extractions';

const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';

const accounts: Account[] = [
  {
    id: 'acc-rico',
    entityId: 'CPF',
    institutionName: 'Rico',
    accountName: 'Conta Corretora Rico',
    accountType: 'investment',
    openingBalance: 10000,
    openingBalanceCents: cents(1000000),
    balance: 10000,
    balanceCents: cents(1000000),
  },
  {
    id: 'acc-inter',
    entityId: 'CPF',
    institutionName: 'Inter',
    accountName: 'Conta Digital Inter',
    accountType: 'checking',
    openingBalance: 1000,
    openingBalanceCents: cents(100000),
    balance: 1000,
    balanceCents: cents(100000),
  },
  {
    id: 'acc-bb',
    entityId: 'CNPJ',
    institutionName: 'Banco do Brasil',
    accountName: 'BB Conta Empresarial',
    accountType: 'business',
    openingBalance: 20000,
    openingBalanceCents: cents(2000000),
    balance: 20000,
    balanceCents: cents(2000000),
  },
  {
    id: 'acc-99pay',
    entityId: 'CPF',
    institutionName: '99Pay',
    accountName: 'Carteira 99Pay',
    accountType: 'checking',
    openingBalance: 500,
    openingBalanceCents: cents(50000),
    balance: 500,
    balanceCents: cents(50000),
  },
];

const extensions: AccountExtensionMeta[] = [
  {
    id: 'acc-rico',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-rico',
    institutionCategory: 'CORRETORA_NACIONAL',
    holderEntity: 'CPF',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'acc-inter',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-inter',
    institutionCategory: 'BANCO_DIGITAL',
    holderEntity: 'CPF',
    maskedAccountNumber: '12345678-9',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'acc-bb',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-bb',
    institutionCategory: 'BANCO_FISICO',
    holderEntity: 'CNPJ',
    agency: '1234-5',
    maskedAccountNumber: '98765-4',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'acc-99pay',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-99pay',
    institutionCategory: 'CARTEIRA_DIGITAL',
    holderEntity: 'CPF',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('Universal Bank Extraction & Reconciliation Engine — All 5 Profiles & Financial Integrity', () => {
  it('1. parses Rico — CSV with alternative headers, BR decimals, protocolo ID and investment asset purchase separation', () => {
    const ricoCsv = [
      `Rico Investimentos;CPF: ${VALID_CPF};Conta: 778899`,
      'Data Operação;Liquidação;Histórico;Ativo;Valor Líquido;Saldo;Protocolo',
      '05/11/2026;07/11/2026;Compra de Ativo;PETR4;-1.500,25;8.499,75;RICO-PROT-01',
      '10/11/2026;10/11/2026;Dividendo Recebido;PETR4;120,50;8.620,25;RICO-PROT-02',
    ].join('\n');

    const parsed = parseCsvStatement(ricoCsv, 'movimentacoes_corretora.csv');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-rico');
    expect(parsed.identifiedAccount.bankCode).toBe('102');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('rico_csv');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].postedDate).toBe('2026-11-07');
    expect(parsed.rows[0].bankTransactionId).toBe('RICO-PROT-01');
    expect(parsed.rows[0].amountSignedCents).toBe(-150025);
    expect(parsed.rows[1].amountSignedCents).toBe(12050);

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-rico',
      fileName: 'movimentacoes_corretora.csv',
      fileSizeBytes: 512,
      contentFingerprint: 'fp-rico',
      parseResult: parsed,
      accounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: extensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-rico');
    expect(batch.movements[0].movementType).toBe('COMPRA_ATIVO');
    expect(batch.movements[1].movementType).toBe('PROVENTO');
    // Balance reconciliation: 10.000,00 - 1.500,25 + 120,50 = 8.620,25
    expect(batch.balanceSummary.openingBalanceCents).toBe(1000000);
    expect(batch.balanceSummary.reportedEndingBalanceCents).toBe(862025);
    expect(batch.balanceSummary.calculatedEndingBalanceCents).toBe(862025);
    expect(batch.balanceSummary.hasDivergence).toBe(false);
    expect(batch.balanceSummary.applicationsCents).toBe(150025);
    expect(batch.balanceSummary.yieldsCents).toBe(12050);
    expect(batch.balanceSummary.operationalExpenseCents).toBe(0);
  });

  it('2. parses Inter — CSV with leading metadata lines (Conta, Período, Saldo), semicolon, and Histórico + Descrição combined', () => {
    const interCsv = [
      'Conta;12345678-9',
      'Período;01/11/2026 a 30/11/2026',
      'Saldo;1.350,00',
      'Data Lançamento;Histórico;Descrição;Valor;Saldo',
      '05/11/2026;Pix recebido;Cliente Beta;500,00;1.500,00',
      '06/11/2026;Pix enviado;Fornecedor Luz;-150,00;1.350,00',
    ].join('\n');

    // Note generic filename "extrato_mensal.csv" — structural Inter CSV profile identifies Banco Inter!
    const parsed = parseCsvStatement(interCsv, 'extrato_mensal.csv');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-inter');
    expect(parsed.identifiedAccount.bankCode).toBe('077');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('inter_csv');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].description).toBe('Pix recebido - Cliente Beta');
    expect(parsed.rows[1].description).toBe('Pix enviado - Fornecedor Luz');
    expect(parsed.openingBalanceCents).toBe(100000);
    expect(parsed.reportedEndingBalanceCents).toBe(135000);

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-inter',
      fileName: 'extrato_mensal.csv',
      fileSizeBytes: 420,
      contentFingerprint: 'fp-inter',
      parseResult: parsed,
      accounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: extensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-inter');
    expect(batch.balanceSummary.operationalIncomeCents).toBe(50000);
    expect(batch.balanceSummary.operationalExpenseCents).toBe(15000);
    expect(batch.balanceSummary.hasDivergence).toBe(false);
  });

  it('3. parses Banco do Brasil — XLSX with Agência/Conta metadata, D/C column, Excel dates, and spaced S A L D O row', () => {
    const wb = XLSX.utils.book_new();
    // Excel serial date 46331 = 2026-11-05
    const ws = XLSX.utils.aoa_to_sheet([
      ['Banco do Brasil S.A.', '', '', '', '', ''],
      ['Agência: 1234-5', 'Conta: 98765-4', `CNPJ: ${VALID_CNPJ}`, '', '', ''],
      ['Data', 'Dependência Origem', 'Histórico', 'Número do documento', 'Valor R$', 'D/C'],
      ['', '', 'Saldo Anterior', '', '20.000,00', 'C'],
      [46331, '0001', 'Recebimento Venda Cartão', '10001', '3.500,00', 'C'],
      [new Date('2026-11-08T14:20:00Z'), '0001', 'Pagamento DAS Simples Nacional', '10002', '650,00', 'D'],
      ['', '', 'S A L D O', '', '22.850,00', 'C'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Extrato BB');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsed = parseSpreadsheetStatement(buf, 'planilha_mov.xlsx');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-bb');
    expect(parsed.identifiedAccount.bankCode).toBe('001');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('bb_xlsx');
    expect(parsed.identifiedAccount.agency).toBe('1234-5');
    expect(parsed.identifiedAccount.holderNature).toBe('CNPJ');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].amountSignedCents).toBe(350000);
    expect(parsed.rows[1].amountSignedCents).toBe(-65000);
    expect(parsed.openingBalanceCents).toBe(2000000);
    expect(parsed.reportedEndingBalanceCents).toBe(2285000);

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-bb',
      fileName: 'planilha_mov.xlsx',
      fileSizeBytes: 2048,
      contentFingerprint: 'fp-bb',
      parseResult: parsed,
      accounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: extensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-bb');
    expect(batch.movements[1].movementType).toBe('IMPOSTO');
    expect(batch.balanceSummary.hasDivergence).toBe(false);
    expect(batch.balanceSummary.calculatedEndingBalanceCents).toBe(2285000);
  });

  it('4. parses 99Pay — XLSX with datetime serials, Cashback, CDI yields, and preserves non-duplicate transactions with distinct IDs', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Extrato Digital 99Pay', `CPF: ${VALID_CPF}`, '', '', '', ''],
      ['Data e Hora', 'Tipo de Transação', 'Descrição', 'Valor', 'ID da Transação', 'Saldo Após'],
      [46331.4375, 'Rendimento', 'Rendimento Conta 99Pay 100% CDI', '12,40', '99P-001', '512,40'],
      ['06/11/2026 09:15:00', 'Cashback', 'Cashback Corrida 99', '5,00', '99P-002', '517,40'],
      ['06/11/2026 12:00:00', 'Pagamento', 'Lanchonete Express', '-25,00', '99P-003', '492,40'],
      ['06/11/2026 12:05:00', 'Pagamento', 'Lanchonete Express', '-25,00', '99P-004', '467,40'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Extrato');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsed = parseSpreadsheetStatement(buf, 'carteira.xlsx');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-99pay');
    expect(parsed.identifiedAccount.bankCode).toBe('301');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('99pay_xlsx');
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0].date).toBe('2026-11-05');

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-99pay',
      fileName: 'carteira.xlsx',
      fileSizeBytes: 1500,
      contentFingerprint: 'fp-99pay',
      parseResult: parsed,
      accounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: extensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-99pay');
    expect(batch.movements[0].movementType).toBe('RENDIMENTO');
    expect(batch.movements[0].investmentMeta?.indexer).toBe('CDI');
    expect(batch.movements[1].movementType).toBe('CASHBACK');

    // Two legitimate R$ 25,00 purchases on the same day with different 99P IDs must NOT be auto-removed!
    expect(batch.movements[2].reviewStatus).not.toBe('DUPLICIDADE');
    expect(batch.movements[3].reviewStatus).not.toBe('DUPLICIDADE');
    expect(batch.movements[3].duplicateStatus).toBe('INEDITA');

    // Reconciliation: 500.00 + 12.40 + 5.00 - 25.00 - 25.00 = 467.40
    expect(batch.balanceSummary.openingBalanceCents).toBe(50000);
    expect(batch.balanceSummary.reportedEndingBalanceCents).toBe(46740);
    expect(batch.balanceSummary.calculatedEndingBalanceCents).toBe(46740);
    expect(batch.balanceSummary.yieldsCents).toBe(1240);
    expect(batch.balanceSummary.cashbackCents).toBe(500);
    expect(batch.balanceSummary.hasDivergence).toBe(false);
  });

  it('5. handles Nubank CSV, PDF, OFX, Aportes PF/PJ, Retiradas de Sócios, Estornos, Aplicações/Resgates and learned rules', () => {
    // 5a. Nubank CSV with anonymous filename and UUID Identificador
    const nuCsv = [
      'Data,Valor,Identificador,Descrição',
      '05/11/2026,-200.00,673a1b2c-1111-4aaa-8bbb-000000000099,Aplicação RDB Resgate Imediato',
      '07/11/2026,200.00,673a1b2c-1111-4aaa-8bbb-000000000100,Resgate RDB',
      '08/11/2026,45.90,673a1b2c-1111-4aaa-8bbb-000000000101,Estorno compra online',
    ].join('\n');
    const parsedNu = parseCsvStatement(nuCsv, 'arquivo_generico.csv');
    expect(parsedNu.identifiedAccount.institutionId).toBe('inst-nubank');
    expect(parsedNu.identifiedAccount.detectedStatementProfile).toBe('nubank_csv');
    expect(parsedNu.rows[0].bankTransactionId).toBe('673a1b2c-1111-4aaa-8bbb-000000000099');

    // 5b. Aporte PF/PJ, Pró-labore, Distribuição de Lucros
    const aporte = classifyExtractedMovement({
      description: 'Aporte PF para capital PJ',
      amountCents: 100000,
      direction: 'INCOME',
      currency: 'BRL',
    });
    expect(aporte.movementType).toBe('TRANSFERENCIA');
    expect(aporte.suggestedSubcategory).toBe('Aporte PF/PJ');

    const proLabore = classifyExtractedMovement({
      description: 'Transferência Pró-labore Sócio Diretor',
      amountCents: 600000,
      direction: 'EXPENSE',
      currency: 'BRL',
    });
    expect(proLabore.movementType).toBe('DESPESA');
    expect(proLabore.suggestedSubcategory).toContain('Pró-labore');

    const distLucros = classifyExtractedMovement({
      description: 'Distribuição de lucros Trimestre',
      amountCents: 1200000,
      direction: 'INCOME',
      currency: 'BRL',
    });
    expect(distLucros.movementType).toBe('RECEITA');
    expect(distLucros.suggestedSubcategory).toBe('Distribuição de Lucros');

    // 5c. Account-scoped learned ExtractionRule applies strictly to the bound account
    const learnedRules: ExtractionRule[] = [
      {
        id: 'er-1',
        keyword: 'ASSINATURA NUVEM CLOUD',
        institutionId: 'inst-bb',
        accountId: 'acc-bb',
        entityId: 'CNPJ',
        movementType: 'DESPESA',
        category: 'Software e Nuvem',
        subcategory: 'Infraestrutura',
        createdAt: '2026-11-01T00:00:00Z',
      },
    ];
    const matchRule = classifyExtractedMovement({
      description: 'PAGTO ASSINATURA NUVEM CLOUD MENSAL',
      amountCents: 29900,
      direction: 'EXPENSE',
      currency: 'BRL',
      institutionId: 'inst-bb',
      accountId: 'acc-bb',
      entityId: 'CNPJ',
      extractionRules: learnedRules,
    });
    expect(matchRule.matchedRuleId).toBe('er-1');
    expect(matchRule.suggestedCategory).toBe('Software e Nuvem');
    expect(matchRule.suggestedSubcategory).toBe('Infraestrutura');

    // Different account must NOT match acc-bb specific rule
    const otherAccountMiss = classifyExtractedMovement({
      description: 'PAGTO ASSINATURA NUVEM CLOUD MENSAL',
      amountCents: 29900,
      direction: 'EXPENSE',
      currency: 'BRL',
      institutionId: 'inst-inter',
      accountId: 'acc-inter',
      entityId: 'CPF',
      extractionRules: learnedRules,
    });
    expect(otherAccountMiss.matchedRuleId).toBeUndefined();

    // 5d. PDF and OFX still integrate cleanly
    const pdfRes = parseTextualPdfContent(
      'Banco Inter S.A.\n05/11/2026 PIX ENVIADO PADARIA -45,00',
      'inter.pdf'
    );
    expect(pdfRes.identifiedAccount.institutionId).toBe('inst-inter');
    const ofxRes = parseOfxStatement(
      '<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>BANCO DO BRASIL</ORG><FID>001</FID></FI></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>001</BANKID><ACCTID>98765-4</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>BB-1</FITID><MEMO>TARIFA</MEMO></STMTTR></BANKTRANLIST><LEDGERBAL><BALAMT>19900.00</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
      'bb.ofx'
    );
    expect(ofxRes.identifiedAccount.institutionId).toBe('inst-bb');
  });

  it('6. consolidates by account, institution, PF/PJ, day, month, and year without double-counting internal transfers', () => {
    const txs: Transaction[] = [
      {
        id: 'tx-1',
        entityId: 'CPF',
        description: 'Salário',
        amount: 5000,
        amountCents: cents(500000),
        direction: 'INCOME',
        category: 'Salário',
        account: 'Conta Digital Inter',
        accountId: 'acc-inter',
        date: '2026-11-05',
        status: 'CONFIRMED',
        origin: 'IMPORT',
      },
      {
        id: 'tx-2',
        entityId: 'CPF',
        description: 'Transferência para 99Pay',
        amount: 500,
        amountCents: cents(50000),
        direction: 'EXPENSE',
        category: 'Transferência',
        account: 'Conta Digital Inter',
        accountId: 'acc-inter',
        date: '2026-11-06',
        status: 'CONFIRMED',
        origin: 'IMPORT',
        isInternalTransfer: true,
        operationType: 'TRANSFERENCIA_PROPRIA',
      },
      {
        id: 'tx-3',
        entityId: 'CNPJ',
        description: 'Venda Serviços PJ',
        amount: 8000,
        amountCents: cents(800000),
        direction: 'INCOME',
        category: 'Vendas',
        account: 'BB Conta Empresarial',
        accountId: 'acc-bb',
        date: '2026-11-06',
        status: 'CONFIRMED',
        origin: 'IMPORT',
      },
    ];

    const summary = computeUniversalPeriodConsolidation({
      transactions: txs,
      accounts,
    });

    expect(summary.totalIncomeCents).toBe(1300000);
    expect(summary.totalExpenseCents).toBe(0);
    expect(summary.totalInternalTransfersCents).toBe(50000);
    expect(summary.byEntity.CPF.incomeCents).toBe(500000);
    expect(summary.byEntity.CNPJ.incomeCents).toBe(800000);
    expect(summary.byDay).toHaveLength(2);
    expect(summary.byMonth[0].key).toBe('2026-11');
    expect(summary.byYear[0].key).toBe('2026');
    expect(summary.byInstitution.length).toBeGreaterThanOrEqual(2);
  });

  it('7. recognizes official Banco do Brasil header (Data | Lançamento | Detalhes | N° documento | Valor | Tipo Lançamento) in CSV and XLSX without bank banner', () => {
    // CSV starting directly on header row with generic filename
    const bbCsv = [
      'Data;Lançamento;Detalhes;N° documento;Valor;Tipo Lançamento',
      '01/11/2026;Saldo Anterior;;;1.000,00;Entrada',
      '05/11/2026;Pix - Recebido;05/11 10:15 CLIENTE ALFA;88123;750,00;Entrada',
      '06/11/2026;Pix - Enviado;06/11 16:40 FORNECEDOR BETA;88124;200,00;Saída',
      '06/11/2026;Saldo do dia;;;1.550,00;Entrada',
    ].join('\n');

    const parsedCsv = parseCsvStatement(bbCsv, 'extrato_novembro.csv');
    expect(parsedCsv.identifiedAccount.institutionId).toBe('inst-bb');
    expect(parsedCsv.identifiedAccount.bankCode).toBe('001');
    expect(parsedCsv.identifiedAccount.bankName).toBe('Banco do Brasil');
    expect(parsedCsv.identifiedAccount.detectedStatementProfile).toBe('bb_csv');
    expect(parsedCsv.rows).toHaveLength(2);
    expect(parsedCsv.rows[0].description).toContain('Pix - Recebido');
    expect(parsedCsv.rows[0].description).toContain('CLIENTE ALFA');
    expect(parsedCsv.rows[0].bankTransactionId).toBe('88123');
    expect(parsedCsv.rows[0].amountSignedCents).toBe(75000);
    expect(parsedCsv.rows[1].amountSignedCents).toBe(-20000);
    expect(parsedCsv.openingBalanceCents).toBe(100000);
    expect(parsedCsv.reportedEndingBalanceCents).toBe(155000);

    // XLSX with the exact screenshot columns and no bank header row
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Data', 'Lançamento', 'Detalhes', 'N° documento', 'Valor', 'Tipo Lançamento'],
      ['01/11/2026', 'Saldo Anterior', '', '', '1.000,00', 'Entrada'],
      ['07/11/2026', 'Compra com Cartão', 'SUPERMERCADO CENTRAL', '99100', '120,50', 'Saída'],
      ['07/11/2026', 'Saldo do dia', '', '', '879,50', 'Entrada'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Extrato');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsedXlsx = parseSpreadsheetStatement(buf, 'planilha_movimentos.xlsx');
    expect(parsedXlsx.identifiedAccount.institutionId).toBe('inst-bb');
    expect(parsedXlsx.identifiedAccount.bankCode).toBe('001');
    expect(parsedXlsx.identifiedAccount.detectedStatementProfile).toBe('bb_xlsx');
    expect(parsedXlsx.rows).toHaveLength(1);
    expect(parsedXlsx.rows[0].description).toContain('Compra com Cartão');
    expect(parsedXlsx.rows[0].bankTransactionId).toBe('99100');
    expect(parsedXlsx.rows[0].amountSignedCents).toBe(-12050);
    expect(parsedXlsx.openingBalanceCents).toBe(100000);
    expect(parsedXlsx.reportedEndingBalanceCents).toBe(87950);
  });

  it('8. matches Banco do Brasil accounts cleanly across short "BB" name, bankCode 001, Ag/Conta with -X/base-4 agency, and zero-padded OFX ACCTID', () => {
    const bbAccounts: Account[] = [
      {
        id: 'acc-bb-pf',
        entityId: 'CPF',
        institutionName: 'BB',
        bankCode: '001',
        accountName: 'BB Conta Corrente 12345-X',
        accountType: 'checking',
        openingBalance: 1000,
        balance: 1000,
      },
      {
        id: 'acc-bb-pj',
        entityId: 'CNPJ',
        institutionName: 'Banco do Brasil',
        bankCode: '001',
        accountName: 'BB Empresarial',
        accountType: 'business',
        openingBalance: 5000,
        balance: 5000,
      },
    ];

    const bbExtensions: AccountExtensionMeta[] = [
      {
        id: 'acc-bb-pf',
        targetKind: 'ACCOUNT',
        institutionId: 'inst-bb',
        institutionCategory: 'BANCO_FISICO',
        holderEntity: 'CPF',
        agency: '1234-5',
        maskedAccountNumber: '12345-X',
        maskedHolderDoc: '***.982.247-**',
        currency: 'BRL',
        status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'acc-bb-pj',
        targetKind: 'ACCOUNT',
        institutionId: 'inst-bb',
        institutionCategory: 'BANCO_FISICO',
        holderEntity: 'CNPJ',
        agency: '1234-5',
        maskedAccountNumber: '00098765-4',
        maskedHolderDoc: '**.222.333/0001-**',
        currency: 'BRL',
        status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    // PDF/CSV header using "Ag/Conta: 1234 / 12345-X" (4-digit base agency without check digit)
    const pdfParsed = parseTextualPdfContent(
      `Banco do Brasil S.A.\nAg/Conta: 1234 / 12345-X\nCPF: ${VALID_CPF}\n05/11/2026 Pix Recebido 300,00`,
      'bb_pf.pdf'
    );
    expect(pdfParsed.identifiedAccount.agency).toBe('1234');
    expect(pdfParsed.identifiedAccount.rawAccountNumberDigits).toBe('12345');

    const boundPf = identifySourceAccount({
      extracted: pdfParsed.identifiedAccount,
      fileName: 'bb_pf.pdf',
      accounts: bbAccounts,
      creditCards: [],
      accountExtensions: bbExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(boundPf.matchedAccountId).toBe('acc-bb-pf');
    expect(boundPf.holderNature).toBe('CPF');

    // OFX zero-padded ACCTID "00000987654" matches stored "00098765-4" on BB PJ
    const bbOfx = `<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>BANCO DO BRASIL</ORG><FID>001</FID></FI></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>001</BANKID><BRANCHID>12345</BRANCHID><ACCTID>00000987654</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>1200.00</TRNAMT><FITID>BB-PJ-1</FITID><MEMO>TED RECEBIDA</MEMO></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>6200.00</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const ofxParsed = parseOfxStatement(bbOfx, 'gerenciador_financeiro_bb.ofx');
    const boundPj = identifySourceAccount({
      extracted: ofxParsed.identifiedAccount,
      fileName: 'gerenciador_financeiro_bb.ofx',
      accounts: bbAccounts,
      creditCards: [],
      accountExtensions: bbExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(boundPj.matchedAccountId).toBe('acc-bb-pj');

    // Account with only short "BB" institutionName and bankCode '001' without extension metadata
    const minimalBbAccounts: Account[] = [
      {
        id: 'acc-bb-minimal',
        entityId: 'CPF',
        institutionName: 'BB',
        bankCode: '001',
        accountName: 'Conta Corrente 12345-X',
        accountType: 'checking',
        openingBalance: 0,
        balance: 0,
      },
    ];
    const boundMinimal = identifySourceAccount({
      extracted: pdfParsed.identifiedAccount,
      fileName: 'extrato_bb.pdf',
      accounts: minimalBbAccounts,
      creditCards: [],
      accountExtensions: [],
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(boundMinimal.matchedAccountId).toBe('acc-bb-minimal');
  });
});
