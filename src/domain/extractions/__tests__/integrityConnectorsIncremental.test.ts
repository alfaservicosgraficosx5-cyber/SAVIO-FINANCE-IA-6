import { describe, expect, it } from 'vitest';
import type { Account, CreditCard, Transaction } from '../../../types';
import type { ExtractionBatch, ParseResultPayload } from '../../../types-sub/extractions';
import {
  buildExtractionBatchFromParseResult,
  EXTRACTION_PARSER_VERSION,
} from '../extractionOrchestrator';
import {
  buildMovementCompositeFingerprint,
  evaluateMovementDuplicates,
} from '../duplicationDetector';
import {
  applyDuplicateUserDecision,
  auditCardInvoiceIntegrity,
  auditExtractionBatchIntegrity,
} from '../financialIntegrityEngine';
import { classifyExtractedMovement } from '../movementClassifier';
import {
  authorizeOpenFinanceConnector,
  buildMergedConnectorStates,
  computeConnectorHealthSummary,
} from '../connectors/connectorRegistry';
import { canExecuteOpenFinanceSync } from '../connectors/openFinanceContract';
import {
  inspectBufferRealMimeAndSecurity,
  MAX_EXTRACTION_FILE_BYTES,
  MAX_PDF_PAGES,
  redactSensitiveBankData,
  sanitizeRawRowSnapshot,
  validateExtractionUploadFile,
  validatePdfPageCount,
} from '../fileSecurity';
import {
  analyzeCardInstallmentCommitments,
  auditCardCsvContent,
  buildAuditedCardTransactions,
  mapAuditedInvoiceToCardRows,
  sanitizeAuditedInvoiceResult,
  type AuditedInvoiceResult,
} from '../../cards/CardInvoiceAuditorService';
import { parseCsvStatement, parseFlexibleDate, parseFlexibleSignedAmount } from '../parsers/csvParser';
import { parseJsonStatement, parseXmlStatement } from '../parsers/structuredParser';
import { requestRemoteOcrParse } from '../parsers/pdfAndImageParser';
import { commitApprovedExtractionMovements } from '../extractionIntegrationService';
import { BUILTIN_INSTITUTIONS } from '../institutionRegistry';
import { cents, toCents } from '../../money/money';

const MOCK_ACCOUNT: Account = {
  id: 'acc-bb-1',
  entityId: 'CPF',
  institutionName: 'Banco do Brasil',
  accountName: 'BB Corrente',
  accountType: 'checking',
  openingBalance: 1000,
  openingBalanceCents: toCents(1000),
  balance: 1000,
  balanceCents: toCents(1000),
  archived: false,
};

const MOCK_CARD: CreditCard = {
  id: 'card-1',
  entityId: 'CPF',
  institutionName: 'Nubank',
  cardName: 'Nubank Gold',
  last4: '4321',
  limit: 8000,
  closingDay: 10,
  dueDay: 17,
  currentInvoiceAmount: 0,
  status: 'OPEN',
};

function makeBaseParseResult(overrides?: Partial<ParseResultPayload>): ParseResultPayload {
  return {
    format: 'OFX',
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName: 'Banco do Brasil',
      bankCode: '001',
      bankType: 'fisico',
      detectionConfidence: 'alta',
      institutionId: 'inst-bb',
      institutionCategory: 'BANCO_FISICO',
      holderNature: 'CPF',
      matchedAccountId: MOCK_ACCOUNT.id,
      requiresConfirmation: false,
    },
    periodStart: '2026-04-01',
    periodEnd: '2026-04-10',
    openingBalanceCents: toCents(1000),
    reportedEndingBalanceCents: toCents(900),
    warnings: [],
    errors: [],
    requiresManualReview: false,
    rows: [
      {
        date: '2026-04-05',
        description: 'PIX ENVIADO MERCADO ALPHA',
        amountSignedCents: cents(-10000),
        currency: 'BRL',
        bankTransactionId: 'FIT-1001',
        rawRowSnapshot: { memo: 'PIX ENVIADO MERCADO ALPHA', fitid: 'FIT-1001' },
      },
    ],
    ...overrides,
  };
}

describe('Phase 1: Incremental Sync, Composite Fingerprint & Safe Re-import', () => {
  it('detects NEW vs EXISTING on safe file re-import without deleting or duplicating records', () => {
    const firstBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-1',
      fileName: 'extrato_bb_abril.ofx',
      fileSizeBytes: 1200,
      contentFingerprint: 'fp-bb-abril',
      parseResult: makeBaseParseResult(),
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    expect(firstBatch.parserVersion).toBe(EXTRACTION_PARSER_VERSION);
    expect(firstBatch.movements[0].syncState).toBe('NEW');
    expect(firstBatch.movements[0].compositeFingerprint).toMatch(/^mfp-/);
    expect(firstBatch.incrementalSummary?.newCount).toBe(1);
    expect(firstBatch.incrementalSummary?.reimportedFileDetected).toBe(false);

    // Re-importing the exact same file marks as safe reimport + EXISTING
    const reimportBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-2',
      fileName: 'extrato_bb_abril.ofx',
      fileSizeBytes: 1200,
      contentFingerprint: 'fp-bb-abril',
      parseResult: makeBaseParseResult(),
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [],
      previousBatches: [firstBatch],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    expect(reimportBatch.reimportOfBatchId).toBe('bat-1');
    expect(reimportBatch.incrementalSummary?.reimportedFileDetected).toBe(true);
    expect(reimportBatch.incrementalSummary?.existingCount).toBe(1);
    expect(reimportBatch.movements[0].syncState).toBe('EXISTING');
    expect(reimportBatch.movements[0].duplicateLayer).toBe('EXATA');
  });

  it('flags UPDATED_SOURCE when same FITID changes amount/description against existing ledger', () => {
    const existingTx: Transaction = {
      id: 'tx-1',
      entityId: 'CPF',
      date: '2026-04-05',
      description: 'PIX ENVIADO MERCADO ALPHA',
      originalDescription: 'PIX ENVIADO MERCADO ALPHA',
      category: 'Alimentação',
      account: 'BB Corrente',
      accountId: MOCK_ACCOUNT.id,
      amount: 100,
      amountCents: toCents(100),
      direction: 'EXPENSE',
      status: 'CONFIRMED',
      origin: 'IMPORT',
      externalId: 'FIT-1001',
    };

    const updatedBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-upd',
      fileName: 'extrato_bb_retificado.ofx',
      fileSizeBytes: 1250,
      contentFingerprint: 'fp-bb-retificado',
      parseResult: makeBaseParseResult({
        rows: [
          {
            date: '2026-04-05',
            description: 'PIX ENVIADO MERCADO ALPHA',
            amountSignedCents: cents(-12500), // Changed from R$ 100 to R$ 125
            currency: 'BRL',
            bankTransactionId: 'FIT-1001',
            rawRowSnapshot: { fitid: 'FIT-1001' },
          },
        ],
      }),
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [existingTx],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    expect(updatedBatch.movements[0].syncState).toBe('UPDATED_SOURCE');
    expect(updatedBatch.movements[0].updatedSourceDiff?.length).toBeGreaterThan(0);
    expect(updatedBatch.incrementalSummary?.updatedSourceCount).toBe(1);
  });

  it('generates stable compositeFingerprint regardless of description case', () => {
    const fp1 = buildMovementCompositeFingerprint({
      institutionId: 'inst-bb',
      targetAccountId: 'acc-1',
      date: '2026-04-05',
      amountCents: 5000,
      direction: 'EXPENSE',
      normalizedDescription: 'padaria central',
    });
    const fp2 = buildMovementCompositeFingerprint({
      institutionId: 'INST-BB',
      targetAccountId: 'acc-1',
      date: '2026-04-05',
      amountCents: 5000,
      direction: 'EXPENSE',
      normalizedDescription: 'padaria central',
    });
    expect(fp1).toBe(fp2);
  });
});

describe('Phase 2: Connectors Registry & Open Finance Consent Contract', () => {
  it('merges connector states and blocks Open Finance execution without explicit consent & token', () => {
    const states = buildMergedConnectorStates({
      persistedStates: [],
      batches: [],
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      workspaceTokenPresent: false,
    });

    expect(states.length).toBeGreaterThanOrEqual(4);
    const openFin = states.find((s) => s.id === 'conn-open-finance-br');
    expect(openFin?.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(canExecuteOpenFinanceSync({ userAuthorized: false, consentTokenPresent: false }).allowed).toBe(false);
    expect(canExecuteOpenFinanceSync({ userAuthorized: true, consentTokenPresent: false }).allowed).toBe(false);
    expect(canExecuteOpenFinanceSync({ userAuthorized: true, consentTokenPresent: true }).allowed).toBe(true);

    const authorizedStates = authorizeOpenFinanceConnector(states, true);
    expect(authorizedStates.find((s) => s.id === 'conn-open-finance-br')?.status).toBe('CONFIGURADO');
    const summary = computeConnectorHealthSummary(authorizedStates);
    expect(summary.totalConnectors).toBe(states.length);
  });
});

describe('Phase 3 & 4: Integrity Engine & Card Installment Commitments', () => {
  it('audits statement batch mathematical divergence without mutating reported or calculated balances', () => {
    const batch = buildExtractionBatchFromParseResult({
      batchId: 'bat-div',
      fileName: 'extrato_div.ofx',
      fileSizeBytes: 900,
      contentFingerprint: 'fp-div',
      parseResult: makeBaseParseResult({
        openingBalanceCents: toCents(1000),
        reportedEndingBalanceCents: toCents(700), // Expected is 1000 - 100 = 900 -> divergence 200
      }),
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    expect(batch.balanceSummary.hasDivergence).toBe(true);
    expect(batch.balanceSummary.reportedEndingBalanceCents).toBe(toCents(700));
    expect(batch.balanceSummary.calculatedEndingBalanceCents).toBe(toCents(900));
    const report = auditExtractionBatchIntegrity({
      batch,
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [],
    });
    expect(report.checklist).toHaveLength(14);
    expect(report.findings.some((f) => f.type === 'DIVERGENCIA_CONCILIACAO_SALDO')).toBe(true);
  });

  it('audits card invoice divergence and prevents duplicate future installments across imports', () => {
    const audited: AuditedInvoiceResult = {
      resumo_fatura: {
        vencimento: '2026-05-17',
        valor_total_identificado: 650, // Reported 650, items sum = 500 -> divergence 150
      },
      transacoes: [
        {
          data: '2026-05-02',
          descricao: 'NOTEBOOK LOJA TECH',
          valor: 400,
          tipo: 'parcelada',
          parcela_atual: 2,
          total_parcelas: 5,
          categoria: 'Compras',
        },
        {
          data: '2026-05-04',
          descricao: 'IOF COMPRA INTERNACIONAL',
          valor: 100,
          tipo: 'avista',
          parcela_atual: 1,
          total_parcelas: 1,
          categoria: 'Outros',
        },
      ],
    };

    const cardAudit = auditCardInvoiceIntegrity({
      audited,
      card: MOCK_CARD,
      existingTransactions: [],
    });

    expect(cardAudit.hasDivergence).toBe(true);
    expect(cardAudit.reportedTotalCents).toBe(toCents(650));
    expect(cardAudit.calculatedNetCents).toBe(toCents(500));
    expect(cardAudit.installmentSummary.activePlansCount).toBe(1);
    expect(cardAudit.installmentSummary.items[0].totalContractedCents).toBe(toCents(2000));
    expect(cardAudit.installmentSummary.items[0].committedFutureBalanceCents).toBe(toCents(1200));

    // First import generates current + 3 future installments (3/5, 4/5, 5/5)
    const rows = mapAuditedInvoiceToCardRows({
      audited,
      targetCard: MOCK_CARD,
      existingTransactions: [],
    });
    const firstImportTxs = buildAuditedCardTransactions({
      rows,
      targetCard: MOCK_CARD,
      importBatchId: 'imp-1',
      generateFutureInstallments: true,
      existingTransactions: [],
    });
    const futureTxs = firstImportTxs.filter((t) => t.status === 'PENDING');
    expect(futureTxs).toHaveLength(3);

    // Simulate existing ledger now holds those generated transactions
    const savedTxs: Transaction[] = firstImportTxs.map((t, i) => ({
      ...t,
      id: `tx-card-${i}`,
    }));

    // Importing next cycle invoice (3/5) must NOT generate duplicate 4/5 or 5/5
    const nextInvoice: AuditedInvoiceResult = {
      resumo_fatura: { vencimento: '2026-06-17', valor_total_identificado: 400 },
      transacoes: [
        {
          data: '2026-06-02',
          descricao: 'NOTEBOOK LOJA TECH',
          valor: 400,
          tipo: 'parcelada',
          parcela_atual: 3,
          total_parcelas: 5,
          categoria: 'Compras',
        },
      ],
    };
    const nextRows = mapAuditedInvoiceToCardRows({
      audited: nextInvoice,
      targetCard: MOCK_CARD,
      existingTransactions: savedTxs,
    });
    const secondImportTxs = buildAuditedCardTransactions({
      rows: nextRows,
      targetCard: MOCK_CARD,
      importBatchId: 'imp-2',
      generateFutureInstallments: true,
      existingTransactions: savedTxs,
    });
    const dupFutureCount = secondImportTxs.filter((t) => t.status === 'PENDING').length;
    expect(dupFutureCount).toBe(0);

    const instCheck = analyzeCardInstallmentCommitments({
      transactions: savedTxs,
      audited: nextInvoice,
      targetCard: MOCK_CARD,
    });
    expect(instCheck.items[0].isProjectedAlready).toBe(true);
  });
});

describe('Phase 5 & 6: Layered Duplication, Suspect Same-Day Safety & AI Rationale', () => {
  it('flags same-day same-amount suspect purchase without auto-deleting and applies user decisions', () => {
    const firstBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-p1',
      fileName: 'ext1.csv',
      fileSizeBytes: 300,
      contentFingerprint: 'fp-1',
      parseResult: makeBaseParseResult({
        format: 'CSV',
        rows: [
          {
            date: '2026-04-07',
            description: 'PADARIA BOM DIA',
            amountSignedCents: cents(-2500),
            currency: 'BRL',
            rawRowSnapshot: { row: 1 },
          },
        ],
      }),
      accounts: [MOCK_ACCOUNT],
      creditCards: [MOCK_CARD],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    const suspectCheck = evaluateMovementDuplicates({
      movement: {
        id: 'mov-new',
        date: '2026-04-07',
        amountCents: cents(2500),
        direction: 'EXPENSE',
        currency: 'BRL',
        normalizedDescription: 'cafeteria express',
        operationType: 'OUTRO',
        movementType: 'DESPESA',
        targetAccountId: MOCK_ACCOUNT.id,
      },
      existingTransactions: [],
      previousBatches: [firstBatch],
      batchSiblings: [],
      accounts: [MOCK_ACCOUNT],
    });

    expect(suspectCheck.classification).toBe('POSSIVEL_DUPLICIDADE');
    expect(suspectCheck.layer).toBe('SUSPEITA');
    expect(suspectCheck.relatedKind).toBe('COMPRA_REPETIDA_ESTABELECIMENTO');

    const resolvedBatch: ExtractionBatch = applyDuplicateUserDecision({
      batch: firstBatch,
      movementId: firstBatch.movements[0].id,
      decision: 'KEEP_BOTH',
      note: 'Duas compras no mesmo dia',
    });
    expect(resolvedBatch.movements[0].duplicateResolution?.decision).toBe('KEEP_BOTH');
    expect(resolvedBatch.correctionsHistory?.length).toBeGreaterThan(0);
  });

  it('produces separated classificationRationale on heuristics and extraction rules', () => {
    const cls = classifyExtractedMovement({
      description: 'PAGAMENTO UBER VIAGEM',
      amountCents: 3500,
      direction: 'EXPENSE',
      currency: 'BRL',
    });
    expect(cls.rationale.suggestedCategory).toBeTruthy();
    expect(cls.rationale.reason).toBeTruthy();
    expect(cls.rationale.evidence).toBeTruthy();
    expect(cls.rationale.score).toBeGreaterThan(0);
  });
});

describe('Phase 9: File Security, MIME Signature, Page Limit & PII Redaction', () => {
  it('blocks disguised executables, scripts/SVG payloads, and oversized PDF page counts', () => {
    const peHeader = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]).buffer; // MZ executable
    expect(inspectBufferRealMimeAndSecurity(peHeader, 'PDF').ok).toBe(false);

    const scriptCsv = new TextEncoder().encode('<script>alert(1)</script>').buffer;
    expect(inspectBufferRealMimeAndSecurity(scriptCsv, 'CSV').ok).toBe(false);

    const validPdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj').buffer;
    expect(inspectBufferRealMimeAndSecurity(validPdf, 'PDF').ok).toBe(true);

    expect(validatePdfPageCount(MAX_PDF_PAGES).ok).toBe(true);
    expect(validatePdfPageCount(MAX_PDF_PAGES + 1).ok).toBe(false);
  });

  it('masks CPF, CNPJ, PAN card digits, and secret keys in logs/snapshots', () => {
    const raw = 'Cliente CPF 123.456.789-01 CNPJ 12.345.678/0001-99 cartao 4111 2222 3333 4444 token=secret123';
    const clean = redactSensitiveBankData(raw);
    expect(clean).not.toContain('123.456.789-01');
    expect(clean).not.toContain('12.345.678');
    expect(clean).not.toContain('4111 2222 3333');
    expect(clean).not.toContain('secret123');
    expect(clean).toContain('[REDACTED]');
  });
});

describe('Section 17 Mandatory Coverage — Statements, Cards & Security Edge Cases', () => {
  it('handles missing opening/ending balances, unknown bank, and malformed CSV/JSON/XML safely', () => {
    const missingBalBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-nobal',
      fileName: 'desconhecido.csv',
      fileSizeBytes: 250,
      contentFingerprint: 'fp-nobal',
      parseResult: makeBaseParseResult({
        format: 'CSV',
        openingBalanceCents: undefined,
        reportedEndingBalanceCents: undefined,
        identifiedAccount: {
          requiresConfirmation: true,
          detectionConfidence: 'baixa',
          confirmationReason: 'Banco não identificado',
        },
      }),
      accounts: [MOCK_ACCOUNT],
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    const audit = auditExtractionBatchIntegrity({
      batch: missingBalBatch,
      accounts: [MOCK_ACCOUNT],
      creditCards: [],
      transactions: [],
    });
    expect(audit.checklist.find((c) => c.code === 'OPENING_BALANCE')?.passed).toBe(false);
    expect(audit.checklist.find((c) => c.code === 'ENDING_BALANCE')?.passed).toBe(false);
    expect(audit.findings.some((f) => f.type === 'SALDO_DOCUMENTO_AUSENTE')).toBe(true);
    expect(audit.findings.some((f) => f.type === 'CONTA_NAO_CONFIRMADA')).toBe(true);

    const unknownCsv = parseCsvStatement(
      'Data\tHistorico\tValor\n05/04/2026\tTRANSFERENCIA RECEBIDA\t1.250,00\n06/04/2026\tPAGAMENTO FORNECEDOR\t(350,40)',
      'banco_xyz.csv'
    );
    expect(unknownCsv.rows).toHaveLength(2);
    expect(unknownCsv.rows[0].amountSignedCents).toBe(125000);
    expect(unknownCsv.rows[1].amountSignedCents).toBe(-35040);
    expect(unknownCsv.identifiedAccount.requiresConfirmation).toBe(true);

    const badJson = parseJsonStatement('{ invalid json :::', 'corrompido.json');
    expect(badJson.errors.length).toBeGreaterThan(0);
    expect(badJson.rows).toHaveLength(0);

    const emptyCsv = parseCsvStatement('   \n  ', 'vazio.csv');
    expect(emptyCsv.errors.length).toBeGreaterThan(0);
    expect(emptyCsv.rows).toHaveLength(0);

    const badXml = parseXmlStatement('not xml at all', 'truncado.xml');
    expect(badXml.rows).toHaveLength(0);
  });

  it('parses BR numbers, negative markers, tab CSV delimiters, and short DD/MM dates cleanly', () => {
    expect(parseFlexibleSignedAmount('(1.234,56)')).toBeCloseTo(-1234.56, 2);
    expect(parseFlexibleSignedAmount('90,25 D')).toBeCloseTo(-90.25, 2);
    expect(parseFlexibleSignedAmount('-R$ 45,10')).toBeCloseTo(-45.1, 2);
    expect(parseFlexibleDate('05/04/2026')).toBe('2026-04-05');
    expect(parseFlexibleDate('2026-04-05')).toBe('2026-04-05');

    // Short DD/MM dates in card invoice CSV
    const csvDdMm = [
      'Data\tEstabelecimento\tValor',
      '05/04\tMERCADO TAB\t120,50',
      '06/04\tREEMBOLSO LOJA\t40,00',
      '07/04\tJUROS ROTATIVO\t15,20',
      '08/04\tCASHBACK FATURA\t10,00',
    ].join('\n');
    const audited = auditCardCsvContent(csvDdMm, 'fatura_tab.csv');
    expect(audited.transacoes).toHaveLength(4);
    expect(audited.transacoes[0].data.endsWith('-04-05')).toBe(true);
    // Reembolso & cashback enforced negative
    expect(audited.transacoes[1].valor).toBe(-40);
    expect(audited.transacoes[3].valor).toBe(-10);

    const rows = mapAuditedInvoiceToCardRows({
      audited,
      targetCard: MOCK_CARD,
      existingTransactions: [],
    });
    expect(rows[1].cardEntryKind).toBe('REVERSAL');
    expect(rows[2].cardEntryKind).toBe('FEE');
    expect(rows[3].cardEntryKind).toBe('REVERSAL');
  });

  it('audits priorBalanceCents on card invoice and integrates own-account transfer without inflating operational totals', () => {
    const audited = sanitizeAuditedInvoiceResult({
      resumo_fatura: { vencimento: '2026-05-17', valor_total_identificado: 350 },
      transacoes: [
        {
          data: '2026-05-03',
          descricao: 'Saldo anterior',
          valor: 150,
          tipo: 'avista',
          parcela_atual: 1,
          total_parcelas: 1,
          categoria: 'Outros',
        },
        {
          data: '2026-05-04',
          descricao: 'SUPERMERCADO Z',
          valor: 200,
          tipo: 'avista',
          parcela_atual: 1,
          total_parcelas: 1,
          categoria: 'Alimentação',
        },
      ],
    });
    // Saldo anterior ignored from purchases list, retained via priorBalanceCents in integrity report
    expect(audited.transacoes).toHaveLength(1);
    const report = auditCardInvoiceIntegrity({
      audited,
      card: MOCK_CARD,
      existingTransactions: [],
      priorBalanceCents: toCents(150),
    });
    expect(report.hasDivergence).toBe(false);
    expect(report.priorBalanceCents).toBe(toCents(150));

    // Own-account transfer paired across two accounts keeps isInternalTransfer = true
    const secondAcc: Account = {
      ...MOCK_ACCOUNT,
      id: 'acc-inter-2',
      institutionName: 'Inter',
      accountName: 'Inter Corrente',
    };
    const transferBatch = buildExtractionBatchFromParseResult({
      batchId: 'bat-trf',
      fileName: 'trf.ofx',
      fileSizeBytes: 500,
      contentFingerprint: 'fp-trf',
      parseResult: makeBaseParseResult({
        rows: [
          {
            date: '2026-04-08',
            description: 'TRANSFERENCIA MESMA TITULARIDADE INTER',
            amountSignedCents: cents(-30000),
            currency: 'BRL',
            bankTransactionId: 'FIT-TRF-1',
            rawRowSnapshot: { memo: 'TRANSFERENCIA MESMA TITULARIDADE INTER' },
          },
        ],
      }),
      accounts: [MOCK_ACCOUNT, secondAcc],
      creditCards: [],
      transactions: [],
      previousBatches: [],
      institutions: BUILTIN_INSTITUTIONS,
      accountExtensions: [],
      categoryRules: [],
      extractionRules: [],
    });

    const approvedTransferBatch: ExtractionBatch = {
      ...transferBatch,
      confirmedAccountId: MOCK_ACCOUNT.id,
      confirmedEntityId: 'CPF',
      movements: transferBatch.movements.map((m) => ({
        ...m,
        entityId: 'CPF',
        targetAccountId: MOCK_ACCOUNT.id,
        transferCounterpartAccountId: secondAcc.id,
        movementType: 'TRANSFERENCIA',
        reviewStatus: 'APROVADO',
      })),
    };

    const commitRes = commitApprovedExtractionMovements({
      batch: approvedTransferBatch,
      accounts: [MOCK_ACCOUNT, secondAcc],
      transactions: [],
      assets: [],
      creditCards: [],
    });
    expect(commitRes.newTransactions).toHaveLength(2);
    expect(commitRes.newTransactions.every((t) => t.isInternalTransfer === true)).toBe(true);
  });

  it('enforces upload size cap, blocks <svg> XSS payloads, strips secrets in snapshots, and handles OCR 500 without corruption', async () => {
    const oversized = validateExtractionUploadFile({
      name: 'extrato_gigante.pdf',
      size: MAX_EXTRACTION_FILE_BYTES + 1,
      type: 'application/pdf',
    });
    expect(oversized.ok).toBe(false);

    const svgPayload = new TextEncoder().encode('<svg onload="alert(1)"></svg>').buffer;
    expect(inspectBufferRealMimeAndSecurity(svgPayload, 'XML').ok).toBe(false);

    const cleanSnapshot = sanitizeRawRowSnapshot({
      memo: 'PIX CPF 123.456.789-01',
      password: 'my-secret-password',
      token: 'tok_live_abc',
      cvv: '999',
    });
    expect(cleanSnapshot.password).toBeUndefined();
    expect(cleanSnapshot.token).toBeUndefined();
    expect(cleanSnapshot.cvv).toBeUndefined();
    expect(String(cleanSnapshot.memo)).not.toContain('123.456.789-01');

    const failOcr = await requestRemoteOcrParse({
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      base64Data: 'ZmFrZQ==',
      format: 'PDF',
      knownAccounts: [],
      fetcher: (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Erro interno no OCR' }),
      })) as unknown as typeof fetch,
    });
    expect(failOcr.rows).toHaveLength(0);
    expect(failOcr.warnings.length).toBeGreaterThan(0);
  });
});
