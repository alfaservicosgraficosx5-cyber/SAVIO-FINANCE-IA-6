import type { Account, CategoryRule, CreditCard, Transaction } from '../../types';
import type {
  AccountExtensionMeta,
  AuditLifecycleStatus,
  BatchCorrectionRecord,
  ConfidenceBreakdown,
  CsvColumnMapping,
  ExtractedMovement,
  ExtractionBatch,
  ExtractionFileFormat,
  ExtractionMethodTag,
  ExtractionRule,
  ExtractionStage,
  IncrementalSyncSummary,
  InstitutionProfile,
  MovementSyncState,
  ParseResultPayload,
} from '../../types-sub/extractions';
import { cents } from '../money/money';
import type { MoneyCents } from '../money/money';
import { generateEntityId } from '../common/id';
import { normalizeDescription } from '../../utils/financeCalculations';
import { todayLocal } from '../../utils/dateLocal';
import { fileStorageService } from '../../services/fileStorage';
import {
  computeBufferFingerprint,
  computeFastHash,
  inspectBufferRealMimeAndSecurity,
  validateExtractionUploadFile,
} from './fileSecurity';
import { decodeTextBuffer, parseOfxStatement } from './parsers/ofxParser';
import { parseCsvStatement } from './parsers/csvParser';
import { parseSpreadsheetStatement } from './parsers/xlsxParser';
import { parseJsonStatement, parseXmlStatement } from './parsers/structuredParser';
import {
  extractTextFromPdfBufferAsync,
  parseTextualPdfContent,
  requestRemoteOcrParse,
} from './parsers/pdfAndImageParser';
import { identifySourceAccount } from './accountIdentifier';
import { classifyExtractedMovement } from './movementClassifier';
import {
  buildMovementCompositeFingerprint,
  evaluateMovementDuplicates,
} from './duplicationDetector';
import { computeStatementBalanceSummary } from './balanceReconciler';
import { detectBankFromStatementAsync } from './banksRepository';
import {
  auditExtractionBatchIntegrity,
  resolveAuditLifecycleStatus,
} from './financialIntegrityEngine';

export const EXTRACTION_PARSER_VERSION = 'savio-ext-6.2.0';

export interface ProcessExtractionParams {
  file: File;
  accounts: Account[];
  creditCards: CreditCard[];
  transactions: Transaction[];
  previousBatches: ExtractionBatch[];
  institutions: InstitutionProfile[];
  accountExtensions: AccountExtensionMeta[];
  categoryRules: CategoryRule[];
  extractionRules: ExtractionRule[];
  allowRemoteOcr?: boolean;
  csvMapping?: CsvColumnMapping;
  xlsxSheetName?: string;
  onStageChange?: (stage: ExtractionStage) => void;
  signal?: AbortSignal;
}

export interface BuildBatchFromParseParams {
  batchId: string;
  fileName: string;
  fileSizeBytes: number;
  fileId?: string;
  contentFingerprint: string;
  parseResult: ParseResultPayload;
  accounts: Account[];
  creditCards: CreditCard[];
  transactions: Transaction[];
  previousBatches: ExtractionBatch[];
  institutions: InstitutionProfile[];
  accountExtensions: AccountExtensionMeta[];
  categoryRules: CategoryRule[];
  extractionRules: ExtractionRule[];
  reimportOfBatchId?: string;
  existingCorrections?: BatchCorrectionRecord[];
  onStageChange?: (stage: ExtractionStage) => void;
}

function blobToBase64Pure(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error('Falha ao ler arquivo em base64.'));
    reader.readAsDataURL(blob);
  });
}

function resolveExtractionMethod(
  parseResult: ParseResultPayload,
  detectedProfile?: string
): ExtractionMethodTag {
  if (parseResult.parseSource === 'OCR_IA') return 'OCR_IA';
  if (parseResult.format === 'PDF') return 'PDFJS_TEXT';
  if (
    detectedProfile &&
    /(bb_|banco_do_brasil|nubank|inter|99pay|rico)/i.test(detectedProfile)
  ) {
    return 'BANK_DEDICATED_PARSER';
  }
  return 'LOCAL_PARSER';
}

export function buildExtractionBatchFromParseResult(
  params: BuildBatchFromParseParams
): ExtractionBatch {
  const {
    batchId,
    fileName,
    fileSizeBytes,
    fileId,
    contentFingerprint,
    parseResult,
    accounts,
    creditCards,
    transactions,
    previousBatches,
    institutions,
    accountExtensions,
    categoryRules,
    extractionRules,
    reimportOfBatchId: explicitReimportId,
    existingCorrections,
    onStageChange,
  } = params;

  const nowIso = new Date().toISOString();

  onStageChange?.('conta');
  const identifiedAccount = identifySourceAccount({
    extracted: parseResult.identifiedAccount,
    fileName,
    accounts,
    creditCards,
    accountExtensions,
    institutions,
  });

  const targetAccountId = identifiedAccount.matchedAccountId;
  const targetCardId = identifiedAccount.matchedCardId;
  const confirmedAcc = accounts.find((a) => a.id === targetAccountId);
  const confirmedCard = creditCards.find((c) => c.id === targetCardId);
  const resolvedEntityId =
    identifiedAccount.holderNature || confirmedAcc?.entityId || confirmedCard?.entityId;

  const bankScore =
    identifiedAccount.detectionConfidence === 'alta'
      ? 0.95
      : identifiedAccount.detectionConfidence === 'media'
        ? 0.75
        : 0.45;
  const accountScore =
    identifiedAccount.matchedAccountId || identifiedAccount.matchedCardId
      ? 0.94
      : identifiedAccount.requiresConfirmation
        ? 0.45
        : 0.85;

  const previousSameFileBatch = previousBatches.find(
    (b) => b.status !== 'CANCELADO' && b.id !== batchId && b.contentFingerprint === contentFingerprint
  );

  onStageChange?.('classificacao');

  const draftMovements: ExtractedMovement[] = parseResult.rows.map((row, idx) => {
    const absCents = cents(Math.abs(row.amountSignedCents)) as MoneyCents;
    const direction = row.amountSignedCents >= 0 ? 'INCOME' : 'EXPENSE';
    const normDesc = normalizeDescription(row.description);
    const effectiveDate = row.date || todayLocal();

    const cls = classifyExtractedMovement({
      description: row.description,
      amountCents: absCents,
      direction,
      currency: row.currency || 'BRL',
      rawOperationHint: row.rawOperationHint,
      counterparty: row.counterparty,
      institutionId: identifiedAccount.institutionId,
      institutionCategory: identifiedAccount.institutionCategory,
      accountId: targetAccountId,
      entityId: resolvedEntityId,
      bankTransactionId: row.bankTransactionId,
      customRules: categoryRules,
      extractionRules,
      rawInvestmentMeta: row.investmentMeta,
      rawCryptoMeta: row.cryptoMeta,
      rawFxMeta: row.fxMeta,
      rawCardMeta: row.cardMeta,
      existingConfidence: row.confidence,
      existingDoubtReason: row.doubtReason,
    });

    const compositeFingerprint = buildMovementCompositeFingerprint({
      institutionId: identifiedAccount.institutionId,
      institutionName: identifiedAccount.bankName,
      targetAccountId: targetAccountId || targetCardId,
      date: effectiveDate,
      amountCents: absCents,
      direction,
      movementType: cls.movementType,
      normalizedDescription: normDesc,
      bankTransactionId: row.bankTransactionId,
      currency: row.currency || 'BRL',
    });

    const idempotencyKey = row.bankTransactionId
      ? `ext-${identifiedAccount.institutionId || 'inst'}-${row.bankTransactionId}`
      : `ext-${computeFastHash(
          `${contentFingerprint}|${idx}|${effectiveDate}|${absCents}|${direction}|${normDesc}`
        )}`;

    const doubtReasons = [
      row.date ? '' : 'Data ausente no documento original; verifique.',
      cls.doubtReason || '',
    ]
      .filter(Boolean)
      .join(' ');

    const needsId = cls.needsIdentification || !row.date || absCents <= 0;

    const baseConfidenceBreakdown: ConfidenceBreakdown = {
      ...(parseResult.parseSource === 'OCR_IA' ? { ocr: row.confidence ?? 0.7 } : {}),
      extraction: row.confidence ?? (parseResult.parseSource === 'LOCAL' ? 0.94 : 0.75),
      bankDetection: bankScore,
      accountMatch: accountScore,
      classification: cls.confidence,
      duplication: 0.95,
    };

    return {
      id: generateEntityId('mov'),
      batchId,
      bankTransactionId: row.bankTransactionId,
      compositeFingerprint,
      institutionName: identifiedAccount.bankName,
      sourceFormat: parseResult.format,
      sourceFileName: fileName,
      date: effectiveDate,
      postedDate: row.postedDate,
      originalDescription: row.description,
      normalizedDescription: normDesc,
      counterparty: cls.counterparty,
      amountCents: absCents,
      amount: absCents / 100,
      direction,
      currency: row.currency || 'BRL',
      movementType: cls.movementType,
      operationType: cls.operationType,
      suggestedCategory: cls.suggestedCategory,
      suggestedSubcategory: cls.suggestedSubcategory,
      entityId: resolvedEntityId,
      targetAccountId,
      targetCardId,
      matchedRuleId: cls.matchedRuleId,
      matchedRuleKeyword: cls.matchedRuleKeyword,
      confidence: cls.confidence,
      confidenceBreakdown: baseConfidenceBreakdown,
      classificationRationale: cls.rationale,
      doubtReason: doubtReasons || undefined,
      syncState: !row.date || absCents <= 0 ? 'INVALID' : needsId ? 'NEEDS_REVIEW' : 'NEW',
      duplicateStatus: 'INEDITA',
      duplicateLayer: 'NONE',
      reviewStatus: needsId ? 'PRECISA_IDENTIFICACAO' : 'PENDENTE',
      rawRowSnapshot: row.rawRowSnapshot,
      manualCorrections: [],
      investmentMeta: cls.investmentMeta,
      cryptoMeta: cls.cryptoMeta,
      fxMeta: cls.fxMeta,
      cardMeta: cls.cardMeta,
      idempotencyKey,
      lineage: [
        {
          timestamp: nowIso,
          stage: 'EXTRAÇÃO',
          actor: 'SISTEMA',
          detail: `Extraído de ${fileName} (${parseResult.format}, origem ${parseResult.parseSource}).`,
        },
        {
          timestamp: nowIso,
          stage: 'CLASSIFICAÇÃO',
          actor: 'SISTEMA',
          detail: `Classificado como ${cls.movementType} · categoria "${cls.suggestedCategory}" (${cls.rationale.reason}).`,
        },
      ],
    };
  });

  onStageChange?.('duplicidades');

  const evaluatedMovements: ExtractedMovement[] = draftMovements.map((mov) => {
    const dup = evaluateMovementDuplicates({
      movement: mov,
      existingTransactions: transactions,
      previousBatches,
      batchSiblings: draftMovements,
      accounts,
    });

    const nextReviewStatus =
      dup.classification === 'DUPLICIDADE_CONFIRMADA'
        ? 'DUPLICIDADE'
        : mov.reviewStatus;

    const effectiveSyncState: MovementSyncState =
      mov.syncState === 'INVALID'
        ? 'INVALID'
        : dup.syncState === 'NEW' && mov.reviewStatus === 'PRECISA_IDENTIFICACAO'
          ? 'NEEDS_REVIEW'
          : dup.syncState;

    return {
      ...mov,
      syncState: effectiveSyncState,
      updatedSourceDiff: dup.updatedSourceDiff,
      duplicateStatus: dup.classification,
      duplicateLayer: dup.layer,
      duplicateRelatedKind: dup.relatedKind,
      duplicateMatchTxId: dup.matchTxId,
      duplicateMatchBatchId: dup.matchBatchId,
      duplicateMatchReason: dup.matchReason,
      transferCounterpartAccountId: dup.transferCounterpartAccountId,
      confidenceBreakdown: mov.confidenceBreakdown
        ? { ...mov.confidenceBreakdown, duplication: dup.duplicationConfidence }
        : undefined,
      reviewStatus: nextReviewStatus,
      lineage:
        dup.classification !== 'INEDITA'
          ? [
              ...mov.lineage,
              {
                timestamp: nowIso,
                stage: 'DUPLICIDADE' as const,
                actor: 'SISTEMA' as const,
                detail: dup.matchReason || `Classificado como ${dup.classification}.`,
              },
            ]
          : mov.lineage,
    };
  });

  onStageChange?.('conferencia');

  const balanceSummary = computeStatementBalanceSummary({
    movements: evaluatedMovements,
    openingBalanceCents: parseResult.openingBalanceCents,
    reportedEndingBalanceCents: parseResult.reportedEndingBalanceCents,
    availableBalanceCents: parseResult.availableBalanceCents,
    blockedBalanceCents: parseResult.blockedBalanceCents,
  });

  const incrementalSummary: IncrementalSyncSummary = {
    totalAnalyzed: evaluatedMovements.length,
    newCount: evaluatedMovements.filter((m) => m.syncState === 'NEW').length,
    existingCount: evaluatedMovements.filter((m) => m.syncState === 'EXISTING').length,
    possibleDuplicateCount: evaluatedMovements.filter(
      (m) => m.syncState === 'POSSIBLE_DUPLICATE'
    ).length,
    updatedSourceCount: evaluatedMovements.filter((m) => m.syncState === 'UPDATED_SOURCE').length,
    needsReviewCount: evaluatedMovements.filter((m) => m.syncState === 'NEEDS_REVIEW').length,
    invalidCount: evaluatedMovements.filter((m) => m.syncState === 'INVALID').length,
    reimportedFileDetected: Boolean(previousSameFileBatch),
    previousBatchId: previousSameFileBatch?.id,
  };

  const warnings = [...parseResult.warnings];
  if (previousSameFileBatch) {
    warnings.push(
      `Reimportação segura detectada: o arquivo "${fileName}" já foi processado anteriormente em ${new Date(
        previousSameFileBatch.importedAt
      ).toLocaleString('pt-BR')}. Registros existentes foram preservados sem duplicação.`
    );
  }

  const periodDates = evaluatedMovements.map((m) => m.date).filter(Boolean).sort();
  const baseBatch: ExtractionBatch = {
    id: batchId,
    fileName,
    format: parseResult.format,
    fileSizeBytes,
    fileId,
    contentFingerprint,
    importedAt: nowIso,
    periodStart: parseResult.periodStart || periodDates[0],
    periodEnd: parseResult.periodEnd || periodDates[periodDates.length - 1],
    stage: 'conferencia',
    status:
      parseResult.errors.length > 0 && evaluatedMovements.length === 0
        ? 'ERRO'
        : 'AGUARDANDO_REVISAO',
    connectorId: targetCardId ? 'conn-card-invoice' : 'conn-local-statement-files',
    extractionMethod: resolveExtractionMethod(
      parseResult,
      identifiedAccount.detectedStatementProfile
    ),
    parserVersion: EXTRACTION_PARSER_VERSION,
    reimportOfBatchId: explicitReimportId || previousSameFileBatch?.id,
    incrementalSummary,
    correctionsHistory: existingCorrections || [],
    identifiedAccount,
    confirmedAccountId: targetAccountId,
    confirmedCardId: targetCardId,
    confirmedInstitutionId: identifiedAccount.institutionId,
    confirmedEntityId: resolvedEntityId,
    balanceSummary,
    warnings,
    errors: parseResult.errors,
    parseSource: parseResult.parseSource,
    movements: evaluatedMovements,
  };

  const integrityAudit = auditExtractionBatchIntegrity({
    batch: baseBatch,
    accounts,
    creditCards,
    transactions,
  });
  const auditLifecycleStatus: AuditLifecycleStatus = resolveAuditLifecycleStatus(
    baseBatch,
    integrityAudit
  );

  return {
    ...baseBatch,
    integrityAudit,
    auditLifecycleStatus,
  };
}

export async function processExtractionFile(
  params: ProcessExtractionParams
): Promise<{ batch: ExtractionBatch; parseResult: ParseResultPayload; buffer: ArrayBuffer }> {
  const {
    file,
    accounts,
    creditCards,
    transactions,
    previousBatches,
    institutions,
    accountExtensions,
    categoryRules,
    extractionRules,
    allowRemoteOcr = false,
    csvMapping,
    xlsxSheetName,
    onStageChange,
    signal,
  } = params;

  const checkAbort = () => {
    if (signal?.aborted) {
      throw new Error('PROCESSAMENTO_CANCELADO');
    }
  };

  onStageChange?.('arquivo');
  const validation = validateExtractionUploadFile(file);
  if (!validation.ok || !validation.format) {
    throw new Error(validation.error || 'Arquivo inválido.');
  }

  const format: ExtractionFileFormat = validation.format;
  const buffer = await file.arrayBuffer();
  checkAbort();

  const signatureCheck = inspectBufferRealMimeAndSecurity(buffer, format);
  if (!signatureCheck.ok) {
    throw new Error(
      signatureCheck.error || 'O conteúdo interno do arquivo não corresponde ao formato declarado.'
    );
  }

  const contentFingerprint = await computeBufferFingerprint(buffer, file.name);
  const batchId = generateEntityId('bat');
  const fileDocId = `extdoc-${batchId}`;

  // Preserve original file safely in IndexedDB (never in localStorage)
  try {
    if (format === 'IMAGE' || format === 'PDF') {
      await fileStorageService.saveDocumentFile(fileDocId, file, file.name, file.type);
    } else {
      await fileStorageService.saveRawBlob(
        fileDocId,
        file,
        file.type || signatureCheck.detectedMime || 'application/octet-stream',
        file.name
      );
    }
  } catch {
    // Non-fatal in headless test environments
  }
  checkAbort();

  onStageChange?.('leitura');

  let parseResult: ParseResultPayload;
  let headerSample = '';
  if (format === 'OFX') {
    const text = decodeTextBuffer(buffer);
    headerSample = text.slice(0, 4000);
    parseResult = parseOfxStatement(text, file.name);
  } else if (format === 'CSV') {
    const text = decodeTextBuffer(buffer);
    headerSample = text.slice(0, 4000);
    parseResult = parseCsvStatement(text, file.name, csvMapping);
  } else if (format === 'XLSX' || format === 'XLS') {
    parseResult = parseSpreadsheetStatement(buffer, file.name, xlsxSheetName, csvMapping);
  } else if (format === 'JSON') {
    const text = decodeTextBuffer(buffer);
    headerSample = text.slice(0, 4000);
    parseResult = parseJsonStatement(text, file.name);
  } else if (format === 'XML') {
    const text = decodeTextBuffer(buffer);
    headerSample = text.slice(0, 4000);
    parseResult = parseXmlStatement(text, file.name);
  } else if (format === 'PDF') {
    const localExtracted = await extractTextFromPdfBufferAsync(buffer);
    checkAbort();
    headerSample = localExtracted.text.slice(0, 4000);
    const localResult = parseTextualPdfContent(localExtracted.text, file.name);
    if (localExtracted.pageCountExceeded && localExtracted.pageLimitError) {
      localResult.warnings.push(localExtracted.pageLimitError);
    }
    if (localResult.rows.length > 0 || !allowRemoteOcr) {
      parseResult = localResult;
      if (localResult.rows.length === 0 && !allowRemoteOcr) {
        parseResult.warnings.push(
          'Este PDF não possui camada textual legível (possível arquivo digitalizado). Autorize o leitor OCR ou insira os lançamentos manualmente na Revisão.'
        );
      }
    } else {
      const b64 = await blobToBase64Pure(file);
      checkAbort();
      parseResult = await requestRemoteOcrParse({
        fileName: file.name,
        mimeType: 'application/pdf',
        base64Data: b64,
        knownAccounts: accounts,
        format: 'PDF',
        signal,
      });
      if (localExtracted.pageCountExceeded && localExtracted.pageLimitError) {
        parseResult.warnings.push(localExtracted.pageLimitError);
      }
    }
  } else {
    // IMAGE
    if (!allowRemoteOcr) {
      parseResult = {
        format: 'IMAGE',
        parseSource: 'LOCAL',
        identifiedAccount: {
          bankName: file.name.replace(/\.(jpg|jpeg|png|webp)$/i, ''),
          requiresConfirmation: true,
          confirmationReason:
            'Autorize a leitura OCR para extrair dados da imagem ou preencha os lançamentos manualmente lado a lado.',
        },
        warnings: [
          'Imagem armazenada com segurança. Clique em "Executar OCR autorizado" para interpretar o extrato fotografado ou insira manualmente.',
        ],
        errors: [],
        requiresManualReview: true,
        rows: [],
      };
    } else {
      const b64 = await blobToBase64Pure(file);
      checkAbort();
      parseResult = await requestRemoteOcrParse({
        fileName: file.name,
        mimeType: file.type || 'image/jpeg',
        base64Data: b64,
        knownAccounts: accounts,
        format: 'IMAGE',
        signal,
      });
    }
  }

  checkAbort();

  // Cached BrasilAPI fallback when a COMPE code was found but static bank resolution remained unknown
  if (
    parseResult.identifiedAccount.bankCode &&
    (!parseResult.identifiedAccount.bankType ||
      parseResult.identifiedAccount.bankType === 'desconhecido')
  ) {
    const asyncDetected = await detectBankFromStatementAsync(
      headerSample || `<BANKID>${parseResult.identifiedAccount.bankCode}</BANKID>`,
      file.name
    );
    if (asyncDetected.type !== 'desconhecido') {
      parseResult.identifiedAccount = {
        ...parseResult.identifiedAccount,
        bankName: asyncDetected.name || parseResult.identifiedAccount.bankName,
        bankCode: asyncDetected.code || parseResult.identifiedAccount.bankCode,
        bankIspb: asyncDetected.ispb || parseResult.identifiedAccount.bankIspb,
        bankType: asyncDetected.type,
        detectionConfidence: asyncDetected.confidence,
        institutionId:
          asyncDetected.institutionId || parseResult.identifiedAccount.institutionId,
        institutionCategory:
          asyncDetected.type === 'fisico'
            ? 'BANCO_FISICO'
            : asyncDetected.type === 'digital'
              ? 'BANCO_DIGITAL'
              : parseResult.identifiedAccount.institutionCategory,
      };
    }
  }

  checkAbort();

  const batch = buildExtractionBatchFromParseResult({
    batchId,
    fileName: file.name,
    fileSizeBytes: file.size,
    fileId: fileDocId,
    contentFingerprint,
    parseResult,
    accounts,
    creditCards,
    transactions,
    previousBatches,
    institutions,
    accountExtensions,
    categoryRules,
    extractionRules,
    onStageChange,
  });

  return { batch, parseResult, buffer };
}

export async function reprocessBatchWithRemoteOcr(params: {
  batch: ExtractionBatch;
  blob: Blob;
  mimeType: string;
  accounts: Account[];
  creditCards: CreditCard[];
  transactions: Transaction[];
  previousBatches: ExtractionBatch[];
  institutions: InstitutionProfile[];
  accountExtensions: AccountExtensionMeta[];
  categoryRules: CategoryRule[];
  extractionRules: ExtractionRule[];
  onStageChange?: (stage: ExtractionStage) => void;
  signal?: AbortSignal;
}): Promise<{ batch: ExtractionBatch; parseResult: ParseResultPayload }> {
  const { batch, blob, mimeType, signal, onStageChange } = params;
  const format: 'PDF' | 'IMAGE' = batch.format === 'PDF' ? 'PDF' : 'IMAGE';

  onStageChange?.('leitura');
  const b64 = await blobToBase64Pure(blob);
  if (signal?.aborted) {
    throw new Error('PROCESSAMENTO_CANCELADO');
  }

  const parseResult = await requestRemoteOcrParse({
    fileName: batch.fileName,
    mimeType: mimeType || (format === 'PDF' ? 'application/pdf' : 'image/jpeg'),
    base64Data: b64,
    knownAccounts: params.accounts,
    format,
    signal,
  });

  if (signal?.aborted) {
    throw new Error('PROCESSAMENTO_CANCELADO');
  }

  const rebuilt = buildExtractionBatchFromParseResult({
    batchId: batch.id,
    fileName: batch.fileName,
    fileSizeBytes: batch.fileSizeBytes,
    fileId: batch.fileId,
    contentFingerprint: batch.contentFingerprint,
    parseResult,
    accounts: params.accounts,
    creditCards: params.creditCards,
    transactions: params.transactions,
    previousBatches: params.previousBatches.filter((b) => b.id !== batch.id),
    institutions: params.institutions,
    accountExtensions: params.accountExtensions,
    categoryRules: params.categoryRules,
    extractionRules: params.extractionRules,
    onStageChange,
  });

  // Preserve any movements already integrated/manually added if OCR returned 0 rows
  if (rebuilt.movements.length === 0 && batch.movements.length > 0) {
    return {
      batch: {
        ...rebuilt,
        movements: batch.movements,
        confirmedAccountId: batch.confirmedAccountId || rebuilt.confirmedAccountId,
        confirmedCardId: batch.confirmedCardId || rebuilt.confirmedCardId,
        confirmedEntityId: batch.confirmedEntityId || rebuilt.confirmedEntityId,
      },
      parseResult,
    };
  }

  return {
    batch: {
      ...rebuilt,
      confirmedAccountId: batch.confirmedAccountId || rebuilt.confirmedAccountId,
      confirmedCardId: batch.confirmedCardId || rebuilt.confirmedCardId,
      confirmedEntityId: batch.confirmedEntityId || rebuilt.confirmedEntityId,
    },
    parseResult,
  };
}
