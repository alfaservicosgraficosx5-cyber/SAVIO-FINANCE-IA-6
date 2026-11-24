import type { MoneyCents } from '../../money/money';
import type { CsvColumnMapping, ParseResultPayload } from '../../../types-sub/extractions';
import {
  sanitizeExtractedText,
  sanitizeRawRowSnapshot,
} from '../fileSecurity';
import { detectBankFromStatement } from '../banksRepository';
import {
  detectStatementProfile,
  extractStatementHolderMetadata,
} from '../bankStatementProfiles';
import { isBancoDoBrasilCsv, parseBancoDoBrasilCsv } from './bancoDoBrasilParser';
import {
  detectCsvDelimiter,
  inferColumnMappingFromHeaders,
  inferExtendedTabularHints,
  normalizeTransactionIdToken,
  parseFlexibleDate,
  parseFlexibleSignedAmount,
  splitCsvLine,
} from './tabularPrimitives';

export {
  detectCsvDelimiter,
  inferColumnMappingFromHeaders,
  inferExtendedTabularHints,
  parseFlexibleDate,
  parseFlexibleSignedAmount,
  splitCsvLine,
};
export type { ExtendedTabularHints } from './tabularPrimitives';

export function parseCsvStatement(
  rawText: string,
  fileName = '',
  explicitMapping?: CsvColumnMapping
): ParseResultPayload {
  const warnings: string[] = [];
  const errors: string[] = [];

  const allLines = rawText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (allLines.length === 0) {
    return {
      format: 'CSV',
      parseSource: 'LOCAL',
      identifiedAccount: { requiresConfirmation: true, confirmationReason: 'Arquivo CSV vazio.' },
      warnings,
      errors: ['O arquivo CSV está vazio.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  const delimiter = explicitMapping?.delimiter || detectCsvDelimiter(allLines);
  let headerIdx = 0;
  for (let i = 0; i < Math.min(20, allLines.length); i++) {
    const cols = splitCsvLine(allLines[i], delimiter);
    if (
      cols.length >= 3 &&
      !cols.some((c) => /\d{2}\/\d{2}\/\d{4}/.test(c) || c.includes(':')) &&
      cols.some((c) => /data|date/i.test(c)) &&
      cols.some((c) =>
        /valor|amount|desc|hist|lancamento|detalhe|ativo|identific|title|debito|credito/i.test(c)
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const leadingMetaLines = allLines.slice(0, headerIdx);
  const headers = splitCsvLine(allLines[headerIdx], delimiter);
  const preHeaderMetaText = [...leadingMetaLines, headers.join(delimiter)].join('\n');

  if (
    isBancoDoBrasilCsv({
      headers,
      leadingMetaLines,
      rawTextSample: preHeaderMetaText,
      fileName,
    })
  ) {
    return parseBancoDoBrasilCsv(rawText, fileName, explicitMapping);
  }

  const mapping = explicitMapping || inferColumnMappingFromHeaders(headers, delimiter);
  const hints = inferExtendedTabularHints(headers);
  const startRow = mapping.hasHeader ? headerIdx + 1 : 0;

  let explicitOpeningBalance: number | undefined;
  let explicitEndingBalance: number | undefined;

  for (const metaLine of leadingMetaLines) {
    const metaCols = splitCsvLine(metaLine, delimiter);
    const joined = metaCols.join(' ');
    if (/saldo\s*(anterior|inicial)/i.test(joined)) {
      const b = parseFlexibleSignedAmount(metaCols[metaCols.length - 1]);
      if (b !== undefined) explicitOpeningBalance = b;
    } else if (/^saldo\b|saldo\s*(atual|final|dispon[ií]vel)/i.test(joined)) {
      const b = parseFlexibleSignedAmount(metaCols[metaCols.length - 1]);
      if (b !== undefined) explicitEndingBalance = b;
    }
  }

  const rows: ParseResultPayload['rows'] = [];
  const rowBalances: Array<{ date: string; idx: number; bal: number; amt: number }> = [];
  let minDate: string | undefined;
  let maxDate: string | undefined;

  for (let i = startRow; i < allLines.length; i++) {
    const cols = splitCsvLine(allLines[i], delimiter);
    if (cols.length < 2) continue;

    const rawDate = cols[mapping.dateCol];
    const parsedDate = parseFlexibleDate(rawDate);
    if (!parsedDate) {
      const joined = cols.join(' ');
      if (/saldo\s*(anterior|inicial|final|atual|total|do\s*dia)|s\s+a\s+l\s+d\s+o/i.test(joined)) {
        const bCell =
          mapping.balanceCol !== undefined
            ? cols[mapping.balanceCol]
            : cols[mapping.amountCol] ?? cols[cols.length - 1];
        let b = parseFlexibleSignedAmount(bCell);
        if (b !== undefined && hints.signIndicatorCol !== undefined) {
          const signRaw = (cols[hints.signIndicatorCol] || '')
            .trim()
            .toUpperCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          if (/^(D|DEB|DEBITO|SAIDA|-)$/.test(signRaw)) b = -Math.abs(b);
          else if (/^(C|CRED|CREDITO|ENTRADA|\+)$/.test(signRaw)) b = Math.abs(b);
        }
        if (b !== undefined) {
          if (/anterior|inicial/i.test(joined)) explicitOpeningBalance = b;
          else explicitEndingBalance = b;
        }
      }
      continue;
    }

    let amt: number | undefined;
    if (mapping.creditCol !== undefined || mapping.debitCol !== undefined) {
      const credit =
        mapping.creditCol !== undefined ? parseFlexibleSignedAmount(cols[mapping.creditCol]) : undefined;
      const debit =
        mapping.debitCol !== undefined ? parseFlexibleSignedAmount(cols[mapping.debitCol]) : undefined;
      if (credit && credit !== 0) amt = Math.abs(credit);
      else if (debit && debit !== 0) amt = -Math.abs(debit);
    }
    if (amt === undefined) {
      amt = parseFlexibleSignedAmount(cols[mapping.amountCol]);
    }
    if (amt === undefined || amt === 0) continue;

    if (hints.signIndicatorCol !== undefined) {
      const signRaw = (cols[hints.signIndicatorCol] || '')
        .trim()
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      if (/^(D|DEB|DEBITO|SAIDA|-)$/.test(signRaw)) {
        amt = -Math.abs(amt);
      } else if (/^(C|CRED|CREDITO|ENTRADA|\+)$/.test(signRaw)) {
        amt = Math.abs(amt);
      }
    }

    const primaryDesc = sanitizeExtractedText(cols[mapping.descriptionCol] || '', 160);
    const secondaryDesc =
      hints.secondaryDescCol !== undefined
        ? sanitizeExtractedText(cols[hints.secondaryDescCol] || '', 160)
        : '';
    const assetText =
      hints.assetCol !== undefined && hints.assetCol !== mapping.descriptionCol
        ? sanitizeExtractedText(cols[hints.assetCol] || '', 40)
        : '';

    const descParts: string[] = [];
    if (primaryDesc) descParts.push(primaryDesc);
    if (
      secondaryDesc &&
      secondaryDesc.toLowerCase() !== primaryDesc.toLowerCase() &&
      !primaryDesc.toLowerCase().includes(secondaryDesc.toLowerCase())
    ) {
      descParts.push(secondaryDesc);
    }
    if (
      assetText &&
      !descParts.join(' ').toLowerCase().includes(assetText.toLowerCase())
    ) {
      descParts.push(assetText);
    }

    const desc = sanitizeExtractedText(descParts.join(' - ') || 'Movimento CSV', 220);

    if (/^(?:saldo\s*(?:anterior|inicial|do\s*dia|final|atual)|s\s+a\s+l\s+d\s+o)\b/i.test(desc)) {
      const balRaw =
        mapping.balanceCol !== undefined
          ? parseFlexibleSignedAmount(cols[mapping.balanceCol])
          : amt;
      if (balRaw !== undefined) {
        if (/anterior|inicial/i.test(desc)) explicitOpeningBalance = balRaw;
        else explicitEndingBalance = balRaw;
      }
      continue;
    }

    if (mapping.balanceCol !== undefined) {
      const bal = parseFlexibleSignedAmount(cols[mapping.balanceCol]);
      if (bal !== undefined) {
        rowBalances.push({ date: parsedDate, idx: rows.length, bal, amt });
      }
    }

    const postedDate =
      hints.postedDateCol !== undefined
        ? parseFlexibleDate(cols[hints.postedDateCol])
        : undefined;
    const rawOperationHint =
      hints.opTypeCol !== undefined
        ? sanitizeExtractedText(cols[hints.opTypeCol] || '', 60) || undefined
        : undefined;

    const signedCents = Math.round(amt * 100) as MoneyCents;
    if (!minDate || parsedDate < minDate) minDate = parsedDate;
    if (!maxDate || parsedDate > maxDate) maxDate = parsedDate;

    const rawObj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      rawObj[h || `col_${idx + 1}`] = cols[idx] ?? '';
    });

    const rowCurrency =
      mapping.currencyCol !== undefined
        ? sanitizeExtractedText(cols[mapping.currencyCol] || '', 10).toUpperCase() || 'BRL'
        : 'BRL';

    rows.push({
      date: parsedDate,
      postedDate,
      description: desc,
      amountSignedCents: signedCents,
      currency: rowCurrency,
      bankTransactionId:
        mapping.idCol !== undefined
          ? normalizeTransactionIdToken(sanitizeExtractedText(cols[mapping.idCol] || '', 100))
          : undefined,
      counterparty:
        mapping.counterpartyCol !== undefined
          ? sanitizeExtractedText(cols[mapping.counterpartyCol] || '', 120) || undefined
          : undefined,
      rawOperationHint,
      rawRowSnapshot: sanitizeRawRowSnapshot(rawObj),
      confidence: 0.92,
    });
  }

  let firstBalance = explicitOpeningBalance;
  let lastBalance = explicitEndingBalance;
  if (rowBalances.length > 0) {
    // Handle both ascending and descending CSV row ordering cleanly
    const isDescending =
      rowBalances.length >= 2 && rowBalances[0].date > rowBalances[rowBalances.length - 1].date;
    const earliest = isDescending ? rowBalances[rowBalances.length - 1] : rowBalances[0];
    const latest = isDescending ? rowBalances[0] : rowBalances[rowBalances.length - 1];
    if (firstBalance === undefined) firstBalance = earliest.bal - earliest.amt;
    if (lastBalance === undefined) lastBalance = latest.bal;
  }

  if (rows.length === 0) {
    warnings.push(
      'Nenhuma linha financeira válida foi extraída. Ajuste o mapeamento de colunas abaixo.'
    );
  }

  const sampleRows = allLines
    .slice(startRow, startRow + 6)
    .map((l) => splitCsvLine(l, delimiter));

  const headerMetadataText = [...leadingMetaLines, headers.join(delimiter)].join('\n');
  const profileDetection = detectStatementProfile({
    format: 'CSV',
    headers,
    headerLines: leadingMetaLines,
    delimiter,
    rawTextSample: headerMetadataText,
    sampleRows,
    fileName,
  });

  const detectedBankRaw = detectBankFromStatement(headerMetadataText, fileName);
  const resolvedBankCode =
    detectedBankRaw.type !== 'desconhecido'
      ? detectedBankRaw.code
      : profileDetection.inferredBankCode || detectedBankRaw.code;
  const resolvedBankName =
    detectedBankRaw.type !== 'desconhecido' && detectedBankRaw.name
      ? detectedBankRaw.name
      : profileDetection.inferredBankName;
  const resolvedBankIspb =
    detectedBankRaw.type !== 'desconhecido'
      ? detectedBankRaw.ispb
      : profileDetection.inferredBankIspb;
  const resolvedBankType =
    detectedBankRaw.type !== 'desconhecido'
      ? detectedBankRaw.type
      : profileDetection.inferredBankType || 'desconhecido';
  const resolvedInstitutionId =
    detectedBankRaw.type !== 'desconhecido'
      ? detectedBankRaw.institutionId
      : profileDetection.inferredInstitutionId;

  const holderMeta = extractStatementHolderMetadata({
    headerText: headerMetadataText,
    bankCode: resolvedBankCode,
    institutionId: resolvedInstitutionId,
  });

  if (holderMeta.hasConflictingTaxDocuments && holderMeta.conflictReason) {
    warnings.push(holderMeta.conflictReason);
  }

  return {
    format: 'CSV',
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName:
        resolvedBankName || (fileName ? fileName.replace(/\.csv$/i, '') : undefined),
      bankCode: resolvedBankCode,
      bankIspb: resolvedBankIspb,
      bankType: resolvedBankType,
      detectionConfidence:
        detectedBankRaw.type !== 'desconhecido'
          ? detectedBankRaw.confidence
          : profileDetection.inferredInstitutionId
            ? 'alta'
            : detectedBankRaw.confidence,
      institutionId: resolvedInstitutionId,
      institutionCategory:
        resolvedInstitutionId === 'inst-rico'
          ? 'CORRETORA_NACIONAL'
          : resolvedBankType === 'fisico'
            ? 'BANCO_FISICO'
            : resolvedBankType === 'digital'
              ? 'BANCO_DIGITAL'
              : undefined,
      detectedStatementProfile: profileDetection.profileId,
      accountProfileId: holderMeta.accountProfileId,
      accountProfileLabel: holderMeta.accountProfileLabel,
      accountType: holderMeta.accountType,
      maskedDocument: holderMeta.maskedDocument,
      documentValid: holderMeta.documentValid,
      holderNature: holderMeta.holderNature,
      agency: holderMeta.agency,
      rawAccountNumberDigits: holderMeta.rawAccountNumberDigits,
      maskedAccountNumber: holderMeta.maskedAccountNumber,
      holderName: holderMeta.holderName,
      companyName: holderMeta.companyName,
      currency: 'BRL',
      requiresConfirmation: true,
      confirmationReason:
        holderMeta.conflictReason ||
        'Confirme a instituição, titularidade CPF/CNPJ e conta do extrato CSV.',
    },
    periodStart: minDate,
    periodEnd: maxDate,
    openingBalanceCents:
      firstBalance !== undefined ? (Math.round(firstBalance * 100) as MoneyCents) : undefined,
    reportedEndingBalanceCents:
      lastBalance !== undefined ? (Math.round(lastBalance * 100) as MoneyCents) : undefined,
    warnings,
    errors,
    requiresManualReview: rows.length === 0 || warnings.length > 0,
    rows,
    tabularPreview: {
      headers,
      sampleRows,
      detectedMapping: mapping,
    },
  };
}
