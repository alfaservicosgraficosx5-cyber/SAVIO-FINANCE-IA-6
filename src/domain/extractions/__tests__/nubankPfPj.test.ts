import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { cents } from '../../money/money';
import { parseCsvStatement } from '../parsers/csvParser';
import { parseOfxStatement } from '../parsers/ofxParser';
import { parseSpreadsheetStatement } from '../parsers/xlsxParser';
import { parseTextualPdfContent } from '../parsers/pdfAndImageParser';
import { identifySourceAccount } from '../accountIdentifier';
import { buildExtractionBatchFromParseResult } from '../extractionOrchestrator';
import { computeUniversalPeriodConsolidation } from '../consolidationEngine';
import { BUILTIN_INSTITUTIONS } from '../institutionRegistry';
import type { Account, Transaction } from '../../../types';
import type { AccountExtensionMeta } from '../../../types-sub/extractions';

const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';

const baseAccounts: Account[] = [
  {
    id: 'acc-nubank-pf',
    entityId: 'CPF',
    institutionName: 'Nubank',
    accountName: 'Conta Pessoal Nubank',
    accountType: 'checking',
    openingBalance: 1000,
    openingBalanceCents: cents(100000),
    balance: 1000,
    balanceCents: cents(100000),
  },
  {
    id: 'acc-nubank-pj',
    entityId: 'CNPJ',
    institutionName: 'Nubank',
    accountName: 'Nubank Empresas Alfa',
    accountType: 'business',
    openingBalance: 5000,
    openingBalanceCents: cents(500000),
    balance: 5000,
    balanceCents: cents(500000),
  },
];

const baseExtensions: AccountExtensionMeta[] = [
  {
    id: 'acc-nubank-pf',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-nubank',
    institutionCategory: 'BANCO_DIGITAL',
    holderEntity: 'CPF',
    agency: '0001',
    maskedAccountNumber: '11123456-7',
    maskedHolderDoc: '***.982.247-**',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'acc-nubank-pj',
    targetKind: 'ACCOUNT',
    institutionId: 'inst-nubank',
    institutionCategory: 'BANCO_DIGITAL',
    holderEntity: 'CNPJ',
    agency: '0001',
    maskedAccountNumber: '99923456-7',
    maskedHolderDoc: '**.222.333/0001-**',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('Nubank PF vs Nubank PJ Differentiation — Mandatory 7 Scenarios', () => {
  it('1. identifies Extrato Nubank PF (CSV & PDF) with CPF, single inst-nubank (260), nubank_pf profile and confirmed agency only when present', () => {
    const csvWithAgency = [
      `Nubank Pessoa Física;Titular: João Silva;CPF: ${VALID_CPF};Agência: 0001;Conta: 11123456-7`,
      'Data,Valor,Identificador,Descrição',
      '05/11/2026,-50.00,673a1b2c-1111-4aaa-8bbb-000000000001,Compra no débito Padaria',
      '06/11/2026,1500.00,673a1b2c-1111-4aaa-8bbb-000000000002,Pix recebido Cliente',
    ].join('\n');

    const parsedCsv = parseCsvStatement(csvWithAgency, 'NU_nov2026.csv');
    expect(parsedCsv.identifiedAccount.institutionId).toBe('inst-nubank');
    expect(parsedCsv.identifiedAccount.bankCode).toBe('260');
    expect(parsedCsv.identifiedAccount.bankIspb).toBe('18236120');
    expect(parsedCsv.identifiedAccount.holderNature).toBe('CPF');
    expect(parsedCsv.identifiedAccount.accountProfileId).toBe('nubank_pf');
    expect(parsedCsv.identifiedAccount.accountProfileLabel).toBe('Nubank Pessoa Física');
    expect(parsedCsv.identifiedAccount.agency).toBe('0001');
    expect(parsedCsv.rows[0].bankTransactionId).toBe('673a1b2c-1111-4aaa-8bbb-000000000001');

    const bound = identifySourceAccount({
      extracted: parsedCsv.identifiedAccount,
      fileName: 'NU_nov2026.csv',
      accounts: baseAccounts,
      creditCards: [],
      accountExtensions: baseExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(bound.matchedAccountId).toBe('acc-nubank-pf');
    expect(bound.accountProfileId).toBe('nubank_pf');

    // CSV WITHOUT agency line must NOT invent '0001'
    const csvNoAgency = [
      `NuConta;Titular: João Silva;CPF: ${VALID_CPF}`,
      'Data,Valor,Identificador,Descrição',
      '05/11/2026,-30.00,673a1b2c-1111-4aaa-8bbb-000000000003,Mercado',
    ].join('\n');
    const parsedNoAg = parseCsvStatement(csvNoAgency, 'extrato.csv');
    expect(parsedNoAg.identifiedAccount.agency).toBeUndefined();
    expect(parsedNoAg.identifiedAccount.accountProfileId).toBe('nubank_pf');

    // PDF Nubank PF
    const pdfText = [
      'Nu Pagamentos S.A. - Extrato Nubank PF',
      `Titular: João Silva · CPF: ${VALID_CPF} · Agência: 0001 · Conta: 11123456-7`,
      'Saldo Anterior R$ 1.000,00',
      '05/11/2026 Pix enviado Padaria -50,00',
      'Saldo Final R$ 950,00',
    ].join('\n');
    const parsedPdf = parseTextualPdfContent(pdfText, 'extrato.pdf');
    expect(parsedPdf.identifiedAccount.bankCode).toBe('260');
    expect(parsedPdf.identifiedAccount.holderNature).toBe('CPF');
    expect(parsedPdf.identifiedAccount.accountProfileId).toBe('nubank_pf');
  });

  it('2. identifies Extrato Nubank PJ across CSV, OFX, PDF and XLSX with CNPJ, companyName and nubank_pj profile', () => {
    const ofxPj = `<OFX>
<SIGNONMSGSRSV1><SONRS><FI><ORG>NUBANK EMPRESAS</ORG><FID>260</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL</CURDEF>
<BANKACCTFROM>
<BANKID>260</BANKID>
<BRANCHID>0001</BRANCHID>
<ACCTID>${VALID_CNPJ}-99923456-7</ACCTID>
<ACCTTYPE>CHECKING</ACCTTYPE>
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261105120000</DTPOSTED><TRNAMT>4500.00</TRNAMT><FITID>NU-PJ-1</FITID><MEMO>Recebimento Nota Fiscal</MEMO></STMTTR>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>9500.00</BALAMT><DTASOF>20261105</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const parsedOfx = parseOfxStatement(ofxPj, 'extrato_empresa.ofx');
    expect(parsedOfx.identifiedAccount.institutionId).toBe('inst-nubank');
    expect(parsedOfx.identifiedAccount.bankCode).toBe('260');
    expect(parsedOfx.identifiedAccount.holderNature).toBe('CNPJ');
    expect(parsedOfx.identifiedAccount.accountProfileId).toBe('nubank_pj');
    expect(parsedOfx.identifiedAccount.accountProfileLabel).toBe('Nubank Empresas / Pessoa Jurídica');
    expect(parsedOfx.identifiedAccount.agency).toBe('0001');

    // XLSX Nubank PJ with Razão Social
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Nubank Empresas - Extrato Conta PJ', '', ''],
      ['Razão Social: Alfa Serviços Gráficos LTDA', `CNPJ: ${VALID_CNPJ}`, 'Agência: 0001 Conta: 99923456-7'],
      ['Data', 'Descrição', 'Valor'],
      ['08/11/2026', 'Recebimento Boleto Cliente', '2500,00'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Extrato');
    const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const parsedXlsx = parseSpreadsheetStatement(xlsxBuf, 'conta.xlsx');
    expect(parsedXlsx.identifiedAccount.institutionId).toBe('inst-nubank');
    expect(parsedXlsx.identifiedAccount.holderNature).toBe('CNPJ');
    expect(parsedXlsx.identifiedAccount.accountProfileId).toBe('nubank_pj');
    expect(parsedXlsx.identifiedAccount.companyName).toContain('Alfa Serviços Gráficos LTDA');

    const boundXlsx = identifySourceAccount({
      extracted: parsedXlsx.identifiedAccount,
      fileName: 'conta.xlsx',
      accounts: baseAccounts,
      creditCards: [],
      accountExtensions: baseExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(boundXlsx.matchedAccountId).toBe('acc-nubank-pj');
  });

  it('3. handles two Nubank accounts with the same bank code (260): disambiguates by ownership/account and requires confirmation when competing', () => {
    const twoPfAccounts: Account[] = [
      ...baseAccounts,
      {
        id: 'acc-nubank-pf-2',
        entityId: 'CPF',
        institutionName: 'Nubank',
        accountName: 'Nubank PF Reserva',
        accountType: 'checking',
        openingBalance: 200,
        openingBalanceCents: cents(20000),
        balance: 200,
        balanceCents: cents(20000),
      },
    ];
    const twoPfExts: AccountExtensionMeta[] = [
      ...baseExtensions,
      {
        id: 'acc-nubank-pf-2',
        targetKind: 'ACCOUNT',
        institutionId: 'inst-nubank',
        institutionCategory: 'BANCO_DIGITAL',
        holderEntity: 'CPF',
        agency: '0001',
        maskedAccountNumber: '44488899-0',
        currency: 'BRL',
        status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    // CSV with CPF but NO account number -> ambiguous between the two PF accounts!
    const pfNoAccountNum = parseCsvStatement(
      `Nubank PF;CPF: ${VALID_CPF}\nData,Valor,Identificador,Descrição\n05/11/2026,-50.00,id-1,Cafe`,
      'nubank.csv'
    );
    const ambRes = identifySourceAccount({
      extracted: pfNoAccountNum.identifiedAccount,
      fileName: 'nubank.csv',
      accounts: twoPfAccounts,
      creditCards: [],
      accountExtensions: twoPfExts,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(ambRes.institutionId).toBe('inst-nubank');
    expect(ambRes.matchedAccountId).toBeUndefined();
    expect(ambRes.ambiguousCandidateAccountIds).toEqual(['acc-nubank-pf', 'acc-nubank-pf-2']);
    expect(ambRes.requiresConfirmation).toBe(true);

    // Same setup, now with PJ CNPJ -> matches acc-nubank-pj uniquely!
    const pjCsv = parseCsvStatement(
      `Nubank Empresas;CNPJ: ${VALID_CNPJ}\nData,Valor,Identificador,Descrição\n05/11/2026,500.00,id-2,Venda`,
      'nubank.csv'
    );
    const pjBound = identifySourceAccount({
      extracted: pjCsv.identifiedAccount,
      fileName: 'nubank.csv',
      accounts: twoPfAccounts,
      creditCards: [],
      accountExtensions: twoPfExts,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(pjBound.matchedAccountId).toBe('acc-nubank-pj');
  });

  it('4. rejects auto-binding when header has divergent CPF and CNPJ, and ignores counterparty CNPJ inside PIX descriptions', () => {
    // 4a. Divergent CPF and CNPJ in header
    const conflictingCsv = [
      `Nubank;CPF: ${VALID_CPF};CNPJ: ${VALID_CNPJ};Conta: 11123456-7`,
      'Data,Valor,Identificador,Descrição',
      '05/11/2026,-100.00,uuid-1,Pix enviado',
    ].join('\n');

    const parsedConflict = parseCsvStatement(conflictingCsv, 'extrato.csv');
    expect(parsedConflict.identifiedAccount.holderNature).toBeUndefined();
    expect(parsedConflict.warnings.some((w) => /conflito|diverg/i.test(w))).toBe(true);

    const conflictIdent = identifySourceAccount({
      extracted: parsedConflict.identifiedAccount,
      fileName: 'extrato.csv',
      accounts: baseAccounts,
      creditCards: [],
      accountExtensions: baseExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(conflictIdent.matchedAccountId).toBeUndefined();
    expect(conflictIdent.requiresConfirmation).toBe(true);

    // 4b. PF statement where a transaction row mentions a supplier's CNPJ must remain PF!
    const pfWithSupplierCnpj = [
      `Nubank PF;CPF: ${VALID_CPF};Conta: 11123456-7`,
      'Data,Valor,Identificador,Descrição',
      `05/11/2026,-350.00,uuid-2,Pix enviado Fornecedor XYZ CNPJ ${VALID_CNPJ}`,
    ].join('\n');
    const parsedPf = parseCsvStatement(pfWithSupplierCnpj, 'extrato.csv');
    expect(parsedPf.identifiedAccount.holderNature).toBe('CPF');
    expect(parsedPf.identifiedAccount.accountProfileId).toBe('nubank_pf');
  });

  it('5. never uses filename alone as ownership proof when file lacks titularity identification', () => {
    const csvWithoutHolder = [
      'Data,Valor,Identificador,Descrição',
      '05/11/2026,-45.00,673a1b2c-1111-4aaa-8bbb-000000000010,Compra Padaria',
      '06/11/2026,200.00,673a1b2c-1111-4aaa-8bbb-000000000011,Pix recebido Maria',
    ].join('\n');

    // Even if named nubank_pj.csv, content has zero titularity proof!
    const parsed = parseCsvStatement(csvWithoutHolder, 'nubank_pj.csv');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-nubank');
    expect(parsed.identifiedAccount.holderNature).toBeUndefined();
    expect(parsed.identifiedAccount.accountProfileId).toBeUndefined();

    const ident = identifySourceAccount({
      extracted: parsed.identifiedAccount,
      fileName: 'nubank_pj.csv',
      accounts: baseAccounts,
      creditCards: [],
      accountExtensions: baseExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(ident.matchedAccountId).toBeUndefined();
    expect(ident.holderNature).toBeUndefined();
    expect(ident.ambiguousCandidateAccountIds).toEqual(['acc-nubank-pf', 'acc-nubank-pj']);
    expect(ident.requiresConfirmation).toBe(true);
  });

  it('6. flags ambiguity when multiple accounts share the same last 4 digits, and resolves when full digits differ', () => {
    const sameLast4Accounts: Account[] = [
      {
        id: 'acc-nu-a',
        entityId: 'CPF',
        institutionName: 'Nubank',
        accountName: 'Nubank Conta A',
        accountType: 'checking',
        openingBalance: 0,
        openingBalanceCents: cents(0),
        balance: 0,
        balanceCents: cents(0),
      },
      {
        id: 'acc-nu-b',
        entityId: 'CPF',
        institutionName: 'Nubank',
        accountName: 'Nubank Conta B',
        accountType: 'checking',
        openingBalance: 0,
        openingBalanceCents: cents(0),
        balance: 0,
        balanceCents: cents(0),
      },
    ];
    const sameLast4Exts: AccountExtensionMeta[] = [
      {
        id: 'acc-nu-a',
        targetKind: 'ACCOUNT',
        institutionId: 'inst-nubank',
        institutionCategory: 'BANCO_DIGITAL',
        holderEntity: 'CPF',
        maskedAccountNumber: '1119991234',
        currency: 'BRL',
        status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'acc-nu-b',
        targetKind: 'ACCOUNT',
        institutionId: 'inst-nubank',
        institutionCategory: 'BANCO_DIGITAL',
        holderEntity: 'CPF',
        maskedAccountNumber: '8887771234',
        currency: 'BRL',
        status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    // 6a. Statement only displays last 4 digits (•••• 1234) -> MUST require confirmation!
    const onlyLast4 = identifySourceAccount({
      extracted: {
        bankCode: '260',
        bankName: 'Nubank',
        institutionId: 'inst-nubank',
        documentValid: true,
        holderNature: 'CPF',
        maskedAccountNumber: '•••• 1234',
        requiresConfirmation: true,
      },
      fileName: 'nubank_pf.csv',
      accounts: sameLast4Accounts,
      creditCards: [],
      accountExtensions: sameLast4Exts,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(onlyLast4.matchedAccountId).toBeUndefined();
    expect(onlyLast4.ambiguousCandidateAccountIds).toEqual(['acc-nu-a', 'acc-nu-b']);
    expect(onlyLast4.confirmationReason).toContain('1234');

    // 6b. Statement provides full account number 8887771234 -> binds strictly to acc-nu-b!
    const fullDigitsMatch = identifySourceAccount({
      extracted: {
        bankCode: '260',
        bankName: 'Nubank',
        institutionId: 'inst-nubank',
        documentValid: true,
        holderNature: 'CPF',
        rawAccountNumberDigits: '8887771234',
        maskedAccountNumber: '8887771234',
        requiresConfirmation: true,
      },
      fileName: 'nubank_pf.csv',
      accounts: sameLast4Accounts,
      creditCards: [],
      accountExtensions: sameLast4Exts,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(fullDigitsMatch.matchedAccountId).toBe('acc-nu-b');
  });

  it('7. detects cross-account transfer between Nubank PF and Nubank PJ without duplicating consolidated totals', () => {
    const pfCsv = [
      `Nubank PF;CPF: ${VALID_CPF};Agência: 0001;Conta: 11123456-7`,
      'Data,Valor,Identificador,Descrição',
      '10/11/2026,-2000.00,tx-pf-2000,Pix enviado Nubank Empresas Alfa',
    ].join('\n');
    const pjCsv = [
      `Nubank Empresas;CNPJ: ${VALID_CNPJ};Agência: 0001;Conta: 99923456-7`,
      'Data,Valor,Identificador,Descrição',
      '10/11/2026,2000.00,tx-pj-2000,Pix recebido João Silva',
    ].join('\n');

    const pfBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-nu-pf',
      fileName: 'nu_pf.csv',
      fileSizeBytes: 300,
      contentFingerprint: 'fp-nu-pf',
      parseResult: parseCsvStatement(pfCsv, 'nu_pf.csv'),
      accounts: baseAccounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: baseExtensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(pfBatch.confirmedAccountId).toBe('acc-nubank-pf');
    expect(pfBatch.confirmedEntityId).toBe('CPF');

    const pjBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-nu-pj',
      fileName: 'nu_pj.csv',
      fileSizeBytes: 300,
      contentFingerprint: 'fp-nu-pj',
      parseResult: parseCsvStatement(pjCsv, 'nu_pj.csv'),
      accounts: baseAccounts,
      creditCards: [],
      transactions: [],
      previousBatches: [pfBatch],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: baseExtensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(pjBatch.confirmedAccountId).toBe('acc-nubank-pj');
    expect(pjBatch.confirmedEntityId).toBe('CNPJ');
    expect(pjBatch.movements[0].duplicateStatus).toBe('TRANSFERENCIA_PROPRIA');
    expect(pjBatch.movements[0].transferCounterpartAccountId).toBe('acc-nubank-pf');

    // Consolidated period calculation ignores internal transfers while reporting them separately
    const txs: Transaction[] = [
      {
        id: 't-out',
        entityId: 'CPF',
        description: 'Pix enviado Nubank Empresas Alfa',
        amount: 2000,
        amountCents: cents(200000),
        direction: 'EXPENSE',
        category: 'Transferência',
        account: 'Conta Pessoal Nubank',
        accountId: 'acc-nubank-pf',
        date: '2026-11-10',
        status: 'CONFIRMED',
        origin: 'IMPORT',
        isInternalTransfer: true,
        operationType: 'TRANSFERENCIA_PROPRIA',
      },
      {
        id: 't-in',
        entityId: 'CNPJ',
        description: 'Pix recebido João Silva',
        amount: 2000,
        amountCents: cents(200000),
        direction: 'INCOME',
        category: 'Transferência',
        account: 'Nubank Empresas Alfa',
        accountId: 'acc-nubank-pj',
        date: '2026-11-10',
        status: 'CONFIRMED',
        origin: 'IMPORT',
        isInternalTransfer: true,
        operationType: 'TRANSFERENCIA_PROPRIA',
      },
    ];

    const consolidated = computeUniversalPeriodConsolidation({
      transactions: txs,
      accounts: baseAccounts,
    });
    expect(consolidated.totalIncomeCents).toBe(0);
    expect(consolidated.totalExpenseCents).toBe(0);
    expect(consolidated.totalInternalTransfersCents).toBe(400000);
  });
});
