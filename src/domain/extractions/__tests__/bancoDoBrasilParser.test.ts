import { describe, it, expect } from 'vitest';
import { parseOfxStatement } from '../parsers/ofxParser';
import { parseCsvStatement } from '../parsers/csvParser';
import { buildExtractionBatchFromParseResult } from '../extractionOrchestrator';
import { identifySourceAccount } from '../accountIdentifier';
import { BUILTIN_INSTITUTIONS } from '../institutionRegistry';
import type { Account } from '../../../types';
import type { AccountExtensionMeta } from '../../../types-sub/extractions';

const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';

const bbAccounts: Account[] = [
  {
    id: 'acc-bb-pf',
    entityId: 'CPF',
    institutionName: 'Banco do Brasil',
    bankCode: '001',
    accountName: 'BB Conta Corrente 12345-X',
    accountType: 'checking',
    openingBalance: 1000,
    balance: 1000,
  },
  {
    id: 'acc-bb-pj',
    entityId: 'CNPJ',
    institutionName: 'BB',
    bankCode: '001',
    accountName: 'BB Empresarial 98765-4',
    accountType: 'business',
    openingBalance: 10000,
    balance: 10000,
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
    maskedAccountNumber: '98765-4',
    maskedHolderDoc: '**.222.333/0001-**',
    currency: 'BRL',
    status: 'ACTIVE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('Banco do Brasil Dedicated Parser (OFX & CSV)', () => {
  it('1. parses BB OFX with unpadded BANKID=1, combined ACCTID agency/account, and detects bb_ofx profile', () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<SIGNONMSGSRSV1><SONRS><LANGUAGE>POR<FI><ORG>BANCO DO BRASIL S/A<FID>1</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM>
<BANKID>1
<ACCTID>1234-5/98765-4
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20261101
<DTEND>20261130
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261105120000[-3:BRT]
<TRNAMT>1500.00
<FITID>202611050001
<MEMO>PIX RECEBIDO CLIENTE &amp; CIA
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>11500.00</BALAMT><DTASOF>20261130</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const parsed = parseOfxStatement(ofx, 'extrato_mensal.ofx');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-bb');
    expect(parsed.identifiedAccount.bankCode).toBe('001');
    expect(parsed.identifiedAccount.bankName).toBe('Banco do Brasil');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('bb_ofx');
    expect(parsed.identifiedAccount.agency).toBe('1234-5');
    expect(parsed.identifiedAccount.rawAccountNumberDigits).toBe('987654');
    expect(parsed.identifiedAccount.maskedAccountNumber).toBe('•••• 65-4');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].description).toBe('PIX RECEBIDO CLIENTE & CIA');
    expect(parsed.rows[0].bankTransactionId).toBe('202611050001');

    const matched = identifySourceAccount({
      extracted: parsed.identifiedAccount,
      fileName: 'extrato_mensal.ofx',
      accounts: bbAccounts,
      creditCards: [],
      accountExtensions: bbExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(matched.matchedAccountId).toBe('acc-bb-pj');
  });

  it('2. resolves BB OFX zero-padded BRANCHID/ACCTID (-X check digit), trailing BANKACCTFROM, and placeholder/degenerate FITIDs', () => {
    const ofx = `<OFX>
<SIGNONMSGSRSV1><SONRS><FI><ORG>BCO DO BRASIL</ORG><FID>0001</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKTRANLIST>
<DTSTART>20261101</DTSTART><DTEND>20261110</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>-45.00</TRNAMT><FITID>000000</FITID><CHECKNUM>77412</CHECKNUM><MEMO>TARIFA PACOTE</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261104</DTPOSTED><TRNAMT>300.00</TRNAMT><FITID>20261104</FITID><MEMO>PIX RECEBIDO E00000000202611041015abcdefghijk</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261104</DTPOSTED><TRNAMT>-80.00</TRNAMT><FITID>20261104</FITID><MEMO>COMPRA DEBITO NSU: 998877</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261105</DTPOSTED><TRNAMT>-12.00</TRNAMT><FITID>0</FITID><MEMO>IOF COBRADO</MEMO></STMTTRN>
</BANKTRANLIST>
<BANKACCTFROM><BANKID>0001</BANKID><BRANCHID>000012345</BRANCHID><ACCTID>00012345X</ACCTID></BANKACCTFROM>
<LEDGERBAL><BALAMT>1163.00</BALAMT></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    const parsed = parseOfxStatement(ofx, 'conta_corrente.ofx');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('bb_ofx');
    expect(parsed.identifiedAccount.bankCode).toBe('001');
    expect(parsed.identifiedAccount.agency).toBe('12345');
    expect(parsed.identifiedAccount.rawAccountNumberDigits).toBe('00012345');

    // Transaction ID fallback chain: placeholder 000000 -> CHECKNUM; degenerate shared FITID -> E2E / NSU; bare 0 -> undefined
    expect(parsed.rows[0].bankTransactionId).toBe('77412');
    expect(parsed.rows[1].bankTransactionId).toBe('E00000000202611041015abcdefghijk');
    expect(parsed.rows[2].bankTransactionId).toBe('998877');
    expect(parsed.rows[3].bankTransactionId).toBeUndefined();

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-bb-ofx-2',
      fileName: 'conta_corrente.ofx',
      fileSizeBytes: 900,
      contentFingerprint: 'fp-bb-ofx-2',
      parseResult: parsed,
      accounts: bbAccounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: bbExtensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-bb-pf');
    // Distinct movements must NEVER collide as DUPLICIDADE_CONFIRMADA due to "0" or repeated date FITID
    expect(batch.movements.every((m) => m.duplicateStatus === 'INEDITA')).toBe(true);
  });

  it('3. parses BB official CSV with delimited Agência/Conta metadata, 00/00/0000 balances, and placeholder 000000 document IDs', () => {
    const bbCsv = [
      '"Banco do Brasil S.A.";"Extrato de Conta Corrente";"Data geração: 10/11/2026"',
      '"Agência";"1234-5";"Conta";"98765-4"',
      `"Cliente";"ALFA GRAFICA LTDA";"CNPJ";"${VALID_CNPJ}"`,
      '"Data";"Lançamento";"Detalhes";"N° documento";"Valor";"Tipo Lançamento"',
      '"00/00/0000";"Saldo Anterior";"";0;"10.000,00";"Entrada"',
      '"05/11/2026";"Pix - Recebido";"05/11 10:15 CLIENTE VIP E00000000202611051015zzzzzzzzzzz";0;"1.250,00";"Entrada"',
      '"06/11/2026";"Tarifa Bancária";"MENSALIDADE PACOTE";000000;"35,00";"Saída"',
      '"06/11/2026";"Pagamento Boleto";"ENERGIA ELETRICA";881234;"215,00";"Saída"',
      '"00/00/0000";"Saldo do dia";"";0;"11.000,00";"Entrada"',
    ].join('\n');

    const parsed = parseCsvStatement(bbCsv, 'extrato.csv');
    expect(parsed.identifiedAccount.institutionId).toBe('inst-bb');
    expect(parsed.identifiedAccount.bankCode).toBe('001');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('bb_csv');
    expect(parsed.identifiedAccount.agency).toBe('1234-5');
    expect(parsed.identifiedAccount.rawAccountNumberDigits).toBe('987654');
    expect(parsed.identifiedAccount.maskedAccountNumber).toBe('•••• 65-4');
    expect(parsed.identifiedAccount.holderNature).toBe('CNPJ');
    expect(parsed.identifiedAccount.holderName).toBe('ALFA GRAFICA LTDA');

    // Balance rows 00/00/0000 correctly extracted despite trailing "Entrada" column
    expect(parsed.openingBalanceCents).toBe(1000000);
    expect(parsed.reportedEndingBalanceCents).toBe(1100000);

    expect(parsed.rows).toHaveLength(3);
    // Row 0 had N° documento = 0, so it falls back to Pix E2E in Detalhes
    expect(parsed.rows[0].bankTransactionId).toBe('E00000000202611051015zzzzzzzzzzz');
    expect(parsed.rows[0].amountSignedCents).toBe(125000);
    // Row 1 had N° documento = 000000 and no structured ID -> undefined (not "000000")
    expect(parsed.rows[1].bankTransactionId).toBeUndefined();
    expect(parsed.rows[1].amountSignedCents).toBe(-3500);
    // Row 2 has real N° documento
    expect(parsed.rows[2].bankTransactionId).toBe('881234');
    expect(parsed.rows[2].amountSignedCents).toBe(-21500);

    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-bb-csv-3',
      fileName: 'extrato.csv',
      fileSizeBytes: 1024,
      contentFingerprint: 'fp-bb-csv-3',
      parseResult: parsed,
      accounts: bbAccounts,
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: bbExtensions,
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.confirmedAccountId).toBe('acc-bb-pj');
    expect(batch.balanceSummary.openingBalanceCents).toBe(1000000);
    expect(batch.balanceSummary.reportedEndingBalanceCents).toBe(1100000);
    expect(batch.balanceSummary.calculatedEndingBalanceCents).toBe(1100000);
    expect(batch.balanceSummary.hasDivergence).toBe(false);
    expect(batch.movements.every((m) => m.duplicateStatus === 'INEDITA')).toBe(true);
  });

  it('4. parses BB Gerenciador Financeiro CSV with Dependência Origem, Data do Balancete, 2-row Agência/Conta header, and Inf. C/D', () => {
    const gfCsv = [
      `Agência;Conta;CPF`,
      `1234-5;12345-X;${VALID_CPF}`,
      'Data;Dependência Origem;Histórico;Data do Balancete;Nr. Doc.;Valor;Inf.',
      '05/11/2026;4021;TED Recebida;06/11/2026;445566;800,00;C',
      '07/11/2026;4021;Débito Automático;07/11/2026;0;120,00;D',
    ].join('\n');

    const parsed = parseCsvStatement(gfCsv, 'movimento.csv');
    expect(parsed.identifiedAccount.detectedStatementProfile).toBe('bb_csv');
    // Agency must come from "Agência" metadata ("1234-5"), NOT per-row "Dependência Origem" ("4021")
    expect(parsed.identifiedAccount.agency).toBe('1234-5');
    expect(parsed.identifiedAccount.rawAccountNumberDigits).toBe('12345');
    expect(parsed.identifiedAccount.holderNature).toBe('CPF');

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].postedDate).toBe('2026-11-06');
    expect(parsed.rows[0].bankTransactionId).toBe('445566');
    expect(parsed.rows[0].amountSignedCents).toBe(80000);
    expect(parsed.rows[1].bankTransactionId).toBeUndefined();
    expect(parsed.rows[1].amountSignedCents).toBe(-12000);

    const matched = identifySourceAccount({
      extracted: parsed.identifiedAccount,
      fileName: 'movimento.csv',
      accounts: bbAccounts,
      creditCards: [],
      accountExtensions: bbExtensions,
      institutions: BUILTIN_INSTITUTIONS,
    });
    expect(matched.matchedAccountId).toBe('acc-bb-pf');
  });
});
