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

export function splitCsvLine(line: string, delimiter: ';' | ',' | '\t'): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function detectCsvDelimiter(lines: string[]): ';' | ',' | '\t' {
  const sample = lines.slice(0, Math.min(12, lines.length));
  const counts: Record<';' | ',' | '\t', number> = { ';': 0, ',': 0, '\t': 0 };
  for (const line of sample) {
    counts[';'] += splitCsvLine(line, ';').length - 1;
    counts[','] += splitCsvLine(line, ',').length - 1;
    counts['\t'] += splitCsvLine(line, '\t').length - 1;
  }
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
  if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t';
  return ',';
}

export function parseFlexibleDate(raw?: string): string | undefined {
  const s = (raw || '').trim();
  if (!s) return undefined;

  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const y = iso[1];
    const m = iso[2].padStart(2, '0');
    const d = iso[3].padStart(2, '0');
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y}-${m}-${d}`;
    }
  }

  const br = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (br) {
    const d = br[1].padStart(2, '0');
    const m = br[2].padStart(2, '0');
    const yRaw = br[3];
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y}-${m}-${d}`;
    }
  }

  return undefined;
}

export function parseFlexibleSignedAmount(raw?: string): number | undefined {
  let s = (raw || '').trim();
  if (!s) return undefined;

  let isNegative = false;
  if (/^\(.*\)$/.test(s)) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  }
  if (/[Dd]$/.test(s) && !/USD|CAD|AUD|BRL/i.test(s)) {
    isNegative = true;
    s = s.slice(0, -1).trim();
  } else if (/[Cc]$/.test(s)) {
    s = s.slice(0, -1).trim();
  }

  s = s.replace(/R\$|US\$|BRL|USD|EUR|€/gi, '').replace(/\s+/g, '');
  if (s.startsWith('-')) {
    isNegative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized = s;
  if (lastComma > lastDot) {
    // Brazilian style: 1.234,56
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // US style: 1,234.56 or 1234.56
    normalized = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    normalized = s.replace(',', '.');
  }

  const val = Number(normalized);
  if (!Number.isFinite(val)) return undefined;
  return isNegative ? -Math.abs(val) : val;
}

export interface ExtendedTabularHints {
  secondaryDescCol?: number;
  assetCol?: number;
  postedDateCol?: number;
  signIndicatorCol?: number;
  opTypeCol?: number;
}

export function inferExtendedTabularHints(headers: string[]): ExtendedTabularHints {
  const norm = headers.map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
  );

  const histIdx = norm.findIndex((h) => /^histor|^lancamento$|historico/.test(h));
  const descIdx = norm.findIndex((h) => /^desc/.test(h) || /detalhe|title|memo/.test(h));
  const assetIdx = norm.findIndex((h) => /^ativo$|ticker|papel/.test(h));
  const postedIdx = norm.findIndex((h) => /liquidac|data\s*balancete|data\s*mov/.test(h));
  const signIdx = norm.findIndex((h) =>
    /^d\/c$|^dc$|^inf\.?$|^natureza$|^tipo\s*(?:de\s*)?lancamento$/.test(h)
  );
  const opTypeIdx = norm.findIndex((h) => /tipo\s*(?:de\s*)?transac|modalidade|operac/.test(h));

  let secondaryDescCol: number | undefined;
  if (histIdx >= 0 && descIdx >= 0 && histIdx !== descIdx) {
    secondaryDescCol = descIdx;
  } else if (opTypeIdx >= 0 && descIdx >= 0 && opTypeIdx !== descIdx) {
    secondaryDescCol = opTypeIdx;
  }

  return {
    secondaryDescCol,
    assetCol: assetIdx >= 0 ? assetIdx : undefined,
    postedDateCol: postedIdx >= 0 ? postedIdx : undefined,
    signIndicatorCol: signIdx >= 0 ? signIdx : undefined,
    opTypeCol: opTypeIdx >= 0 ? opTypeIdx : undefined,
  };
}

export function inferColumnMappingFromHeaders(
  headers: string[],
  delimiter: ';' | ',' | '\t'
): CsvColumnMapping {
  const norm = headers.map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
  );

  const findIdx = (patterns: RegExp[]) => {
    for (const p of patterns) {
      const idx = norm.findIndex((h) => p.test(h));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const dateCol = Math.max(
    0,
    findIdx([/^data$/, /^data\s*(?:lancamento|operacao|transacao|e\s*hora)?$/, /data/, /date/, /dt/, /venc/])
  );
  let descriptionCol = findIdx([
    /^historico$/,
    /^lancamento$/,
    /^desc/,
    /hist/,
    /memo/,
    /titulo/,
    /^title$/,
    /estabelec/,
    /detalhe/,
    /ativo/,
  ]);
  if (descriptionCol < 0) descriptionCol = Math.min(1, Math.max(0, headers.length - 1));

  const debitColIdx = findIdx([/^debito$/, /saida/, /valor\s*debit/]);
  const creditColIdx = findIdx([/^credito$/, /entrada/, /valor\s*credit/]);
  let amountCol = findIdx([/valor\s*liquido/, /^valor$/, /valor/, /amount/, /quantia/, /montante/, /total/, /liquido/]);
  if (amountCol < 0 && headers.length > 2) amountCol = headers.length - 1;

  const counterpartyColIdx = findIdx([/favorec/, /pagador/, /destin/, /origem/, /contra/, /merchant/]);
  const balanceColIdx = findIdx([/saldo\s*apos/, /^saldo/, /saldo/, /balance/]);
  const idColIdx = findIdx([
    /fitid/,
    /^id(?:\s*da\s*transac[aã]o)?$/,
    /numero\s*(?:do\s*)?documento/,
    /n[ºo°.]*\s*documento/,
    /nro\.?\s*documento/,
    /^documento$/,
    /identific/,
    /protocolo/,
    /codigo/,
    /e2e/,
    /txhash/,
    /nsu/,
  ]);
  const currencyColIdx = findIdx([/^moeda$/, /^currency$/, /divisa/]);

  return {
    hasHeader: true,
    delimiter,
    dateCol,
    descriptionCol,
    amountCol: Math.max(0, amountCol),
    debitCol: debitColIdx >= 0 ? debitColIdx : undefined,
    creditCol: creditColIdx >= 0 ? creditColIdx : undefined,
    counterpartyCol: counterpartyColIdx >= 0 ? counterpartyColIdx : undefined,
    balanceCol: balanceColIdx >= 0 ? balanceColIdx : undefined,
    idCol: idColIdx >= 0 ? idColIdx : undefined,
    currencyCol: currencyColIdx >= 0 ? currencyColIdx : undefined,
  };
}

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
  for (let i = 0; i < Math.min(15, allLines.length); i++) {
    const cols = splitCsvLine(allLines[i], delimiter);
    if (
      cols.length >= 3 &&
      cols.some((c) => /data|date/i.test(c)) &&
      cols.some((c) => /valor|amount|desc|hist|ativo|identific|title|debito|credito/i.test(c))
    ) {
      headerIdx = i;
      break;
    }
  }

  const leadingMetaLines = allLines.slice(0, headerIdx);
  const headers = splitCsvLine(allLines[headerIdx], delimiter);
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
      if (/saldo\s*(anterior|inicial)/i.test(joined)) {
        const b = parseFlexibleSignedAmount(cols[cols.length - 1]);
        if (b !== undefined) explicitOpeningBalance = b;
      } else if (/saldo\s*(final|atual|total)|s\s+a\s+l\s+d\s+o/i.test(joined)) {
        const b = parseFlexibleSignedAmount(cols[cols.length - 1]);
        if (b !== undefined) explicitEndingBalance = b;
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
          ? sanitizeExtractedText(cols[mapping.idCol] || '', 100) || undefined
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

  const headerMetadataText = [...leadingMetaLines, headers.join(' ')].join('\n');
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
