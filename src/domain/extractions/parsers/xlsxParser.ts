import * as XLSX from 'xlsx';
import type { MoneyCents } from '../../money/money';
import type { CsvColumnMapping, ParseResultPayload } from '../../../types-sub/extractions';
import {
  sanitizeExtractedText,
  sanitizeRawRowSnapshot,
} from '../fileSecurity';
import {
  inferColumnMappingFromHeaders,
  inferExtendedTabularHints,
  parseFlexibleDate,
  parseFlexibleSignedAmount,
} from './csvParser';
import { sanitizeCellForSheet } from '../../../utils/sheetGuard';
import { detectBankFromStatement } from '../banksRepository';
import {
  detectStatementProfile,
  extractStatementHolderMetadata,
} from '../bankStatementProfiles';

function excelDateToIso(val: unknown): string | undefined {
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 25000 && val < 80000) {
    // Handle both integer dates and Excel datetime cells with fractional day time (e.g. 46331.604166)
    const utcDays = Math.floor(val - 25569);
    const msOffset = Math.round(((val - Math.floor(val)) * 86400) * 1000);
    const d = new Date(utcDays * 86400 * 1000 + msOffset);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  return parseFlexibleDate(String(val ?? ''));
}

export function parseSpreadsheetStatement(
  buffer: ArrayBuffer,
  fileName = '',
  selectedSheetName?: string,
  explicitMapping?: CsvColumnMapping
): ParseResultPayload {
  const format = fileName.toLowerCase().endsWith('.xls') ? 'XLS' : 'XLSX';
  const warnings: string[] = [];
  const errors: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      bookVBA: false,
    });
  } catch (err) {
    return {
      format,
      parseSource: 'LOCAL',
      identifiedAccount: { requiresConfirmation: true },
      warnings,
      errors: [err instanceof Error ? err.message : 'Falha ao abrir planilha.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return {
      format,
      parseSource: 'LOCAL',
      identifiedAccount: { requiresConfirmation: true },
      warnings,
      errors: ['Nenhuma aba encontrada na planilha.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  const chosenSheet =
    selectedSheetName && sheetNames.includes(selectedSheetName) ? selectedSheetName : sheetNames[0];
  const sheet = workbook.Sheets[chosenSheet];
  const rawMatrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });

  const nonEmptyRows: Array<Array<string | number | Date>> = rawMatrix
    .map((r) =>
      (Array.isArray(r) ? r : []).map((cell): string | number | Date => {
        if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell;
        if (typeof cell === 'number') return cell;
        return String(sanitizeCellForSheet(cell == null ? '' : String(cell))).replace(/^'/, '');
      })
    )
    .filter((r) => r.some((cell) => (cell instanceof Date ? true : String(cell).trim() !== '')));

  if (nonEmptyRows.length === 0) {
    return {
      format,
      parseSource: 'LOCAL',
      identifiedAccount: { requiresConfirmation: true },
      warnings: [`A aba "${chosenSheet}" não possui linhas preenchidas.`],
      errors,
      requiresManualReview: true,
      rows: [],
      tabularPreview: {
        sheetNames,
        selectedSheet: chosenSheet,
        headers: [],
        sampleRows: [],
      },
    };
  }

  let headerIdx = 0;
  for (let i = 0; i < Math.min(20, nonEmptyRows.length); i++) {
    const strCols = nonEmptyRows[i].map((c) => (c instanceof Date ? c.toISOString() : String(c)));
    if (
      strCols.length >= 3 &&
      strCols.some((c) => /data|date/i.test(c)) &&
      strCols.some((c) =>
        /valor|amount|desc|hist|ativo|lancamento|detalhe|tipo\s*de\s*transac|tipo\s*lancamento|debito|credito/i.test(
          c
        )
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const leadingMetaRows = nonEmptyRows.slice(0, headerIdx);
  const headers = nonEmptyRows[headerIdx].map((c, idx) =>
    (c instanceof Date ? c.toISOString().slice(0, 10) : String(c || `Coluna ${idx + 1}`)).trim()
  );
  const mapping = explicitMapping || inferColumnMappingFromHeaders(headers, ';');
  const hints = inferExtendedTabularHints(headers);
  const startRow = mapping.hasHeader ? headerIdx + 1 : 0;

  let explicitOpeningBalance: number | undefined;
  let explicitEndingBalance: number | undefined;

  for (const metaRow of leadingMetaRows) {
    const joined = metaRow.map((c) => String(c)).join(' ');
    const lastVal = metaRow[metaRow.length - 1];
    if (/saldo\s*(anterior|inicial)/i.test(joined)) {
      const bal = typeof lastVal === 'number' ? lastVal : parseFlexibleSignedAmount(String(lastVal ?? ''));
      if (bal !== undefined) explicitOpeningBalance = bal;
    } else if (/^saldo\b|saldo\s*(atual|final|dispon[ií]vel)/i.test(joined)) {
      const bal = typeof lastVal === 'number' ? lastVal : parseFlexibleSignedAmount(String(lastVal ?? ''));
      if (bal !== undefined) explicitEndingBalance = bal;
    }
  }

  const rows: ParseResultPayload['rows'] = [];
  const rowBalances: Array<{ date: string; bal: number; amt: number }> = [];
  let minDate: string | undefined;
  let maxDate: string | undefined;

  for (let i = startRow; i < nonEmptyRows.length; i++) {
    const rowArr = nonEmptyRows[i];
    if (rowArr.length < 2) continue;

    const joined = rowArr.map((c) => (c instanceof Date ? c.toISOString() : String(c))).join(' ');

    // Banco do Brasil & banking summary lines (e.g. "S A L D O", "Saldo Anterior", "Saldo do dia", "Saldo Atual")
    if (/^(?:.*?\b)?(?:s\s+a\s+l\s+d\s+o|saldo\s*(?:anterior|inicial|final|atual|do\s*dia))\b/i.test(joined)) {
      const balCell =
        mapping.balanceCol !== undefined
          ? rowArr[mapping.balanceCol]
          : rowArr[mapping.amountCol] ?? rowArr[rowArr.length - 1];
      let bal =
        typeof balCell === 'number'
          ? balCell
          : parseFlexibleSignedAmount(String(balCell ?? ''));
      if (bal === undefined) {
        for (let c = rowArr.length - 1; c >= 0; c--) {
          const parsed =
            typeof rowArr[c] === 'number'
              ? (rowArr[c] as number)
              : parseFlexibleSignedAmount(String(rowArr[c] ?? ''));
          if (parsed !== undefined) {
            bal = parsed;
            break;
          }
        }
      }
      if (bal !== undefined) {
        if (hints.signIndicatorCol !== undefined) {
          const signRaw = String(rowArr[hints.signIndicatorCol] ?? '')
            .trim()
            .toUpperCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          if (/^(D|DEB|DEBITO|SAIDA|-)$/.test(signRaw)) bal = -Math.abs(bal);
          else if (/^(C|CRED|CREDITO|ENTRADA|\+)$/.test(signRaw)) bal = Math.abs(bal);
        }
        if (/anterior|inicial/i.test(joined)) explicitOpeningBalance = bal;
        else explicitEndingBalance = bal;
      }
      continue;
    }

    const dateIso = excelDateToIso(rowArr[mapping.dateCol]);
    if (!dateIso) continue;

    let amt: number | undefined;
    if (mapping.creditCol !== undefined || mapping.debitCol !== undefined) {
      const creditCell = mapping.creditCol !== undefined ? rowArr[mapping.creditCol] : undefined;
      const debitCell = mapping.debitCol !== undefined ? rowArr[mapping.debitCol] : undefined;
      const creditVal =
        typeof creditCell === 'number'
          ? creditCell
          : parseFlexibleSignedAmount(String(creditCell ?? ''));
      const debitVal =
        typeof debitCell === 'number'
          ? debitCell
          : parseFlexibleSignedAmount(String(debitCell ?? ''));
      if (creditVal && creditVal !== 0) amt = Math.abs(creditVal);
      else if (debitVal && debitVal !== 0) amt = -Math.abs(debitVal);
    }

    if (amt === undefined) {
      const amtCell = rowArr[mapping.amountCol];
      amt =
        typeof amtCell === 'number' ? amtCell : parseFlexibleSignedAmount(String(amtCell ?? ''));
    }

    if (amt === undefined || !Number.isFinite(amt) || amt === 0) continue;

    if (hints.signIndicatorCol !== undefined) {
      const signRaw = String(rowArr[hints.signIndicatorCol] ?? '')
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

    const primaryDesc = sanitizeExtractedText(
      String(rowArr[mapping.descriptionCol] || ''),
      160
    );
    const secondaryDesc =
      hints.secondaryDescCol !== undefined
        ? sanitizeExtractedText(String(rowArr[hints.secondaryDescCol] ?? ''), 160)
        : '';

    const descParts: string[] = [];
    if (secondaryDesc && hints.opTypeCol === hints.secondaryDescCol) {
      descParts.push(secondaryDesc);
      if (primaryDesc && primaryDesc.toLowerCase() !== secondaryDesc.toLowerCase()) {
        descParts.push(primaryDesc);
      }
    } else {
      if (primaryDesc) descParts.push(primaryDesc);
      if (
        secondaryDesc &&
        secondaryDesc.toLowerCase() !== primaryDesc.toLowerCase() &&
        !primaryDesc.toLowerCase().includes(secondaryDesc.toLowerCase())
      ) {
        descParts.push(secondaryDesc);
      }
    }

    const desc = sanitizeExtractedText(descParts.join(' - ') || 'Movimento Planilha', 220);

    if (/^(?:saldo\s*(?:anterior|inicial|do\s*dia|final|atual)|s\s+a\s+l\s+d\s+o)\b/i.test(desc)) continue;

    if (mapping.balanceCol !== undefined) {
      const bCell = rowArr[mapping.balanceCol];
      const bal = typeof bCell === 'number' ? bCell : parseFlexibleSignedAmount(String(bCell ?? ''));
      if (bal !== undefined) {
        rowBalances.push({ date: dateIso, bal, amt });
      }
    }

    const postedDate =
      hints.postedDateCol !== undefined
        ? excelDateToIso(rowArr[hints.postedDateCol])
        : undefined;
    const rawOperationHint =
      hints.opTypeCol !== undefined
        ? sanitizeExtractedText(String(rowArr[hints.opTypeCol] ?? ''), 60) || undefined
        : undefined;

    const signedCents = Math.round(amt * 100) as MoneyCents;
    if (!minDate || dateIso < minDate) minDate = dateIso;
    if (!maxDate || dateIso > maxDate) maxDate = dateIso;

    const rawObj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      const c = rowArr[idx];
      rawObj[h] = c instanceof Date ? c.toISOString() : c ?? '';
    });

    rows.push({
      date: dateIso,
      postedDate,
      description: desc,
      amountSignedCents: signedCents,
      currency: 'BRL',
      bankTransactionId:
        mapping.idCol !== undefined
          ? sanitizeExtractedText(String(rowArr[mapping.idCol] ?? ''), 100) || undefined
          : undefined,
      counterparty:
        mapping.counterpartyCol !== undefined
          ? sanitizeExtractedText(String(rowArr[mapping.counterpartyCol] ?? ''), 120) || undefined
          : undefined,
      rawOperationHint,
      rawRowSnapshot: sanitizeRawRowSnapshot(rawObj),
      confidence: 0.91,
    });
  }

  let firstBalance = explicitOpeningBalance;
  let lastBalance = explicitEndingBalance;
  if (rowBalances.length > 0) {
    const isDescending =
      rowBalances.length >= 2 && rowBalances[0].date > rowBalances[rowBalances.length - 1].date;
    const earliest = isDescending ? rowBalances[rowBalances.length - 1] : rowBalances[0];
    const latest = isDescending ? rowBalances[0] : rowBalances[rowBalances.length - 1];
    if (firstBalance === undefined) firstBalance = earliest.bal - earliest.amt;
    if (lastBalance === undefined) lastBalance = latest.bal;
  }

  if (sheetNames.length > 1) {
    warnings.push(
      `Planilha com ${sheetNames.length} abas (${sheetNames.join(', ')}). Exibindo aba "${chosenSheet}".`
    );
  }

  const headerLines = leadingMetaRows.map((r) =>
    r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c))).join(' ')
  );
  const headerMetaText = [...headerLines, headers.join(' ')].join('\n');

  const sampleRows = nonEmptyRows
    .slice(startRow, startRow + 6)
    .map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));

  const profileDetection = detectStatementProfile({
    format,
    headers,
    headerLines,
    rawTextSample: [...headerLines, ...nonEmptyRows.slice(startRow, startRow + 15).map((r) => r.join(' '))].join('\n'),
    sampleRows,
    fileName,
  });

  const detectedBankRaw = detectBankFromStatement(headerMetaText, fileName);
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
    headerText: headerMetaText,
    bankCode: resolvedBankCode,
    institutionId: resolvedInstitutionId,
  });

  if (holderMeta.hasConflictingTaxDocuments && holderMeta.conflictReason) {
    warnings.push(holderMeta.conflictReason);
  }

  return {
    format,
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName:
        resolvedBankName ||
        (fileName ? fileName.replace(/\.(xlsx|xls)$/i, '') : undefined),
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
        'Confirme a aba selecionada, instituição e conta vinculada.',
    },
    periodStart: minDate,
    periodEnd: maxDate,
    openingBalanceCents:
      firstBalance !== undefined ? (Math.round(firstBalance * 100) as MoneyCents) : undefined,
    reportedEndingBalanceCents:
      lastBalance !== undefined ? (Math.round(lastBalance * 100) as MoneyCents) : undefined,
    warnings,
    errors,
    requiresManualReview: rows.length === 0 || sheetNames.length > 1 || warnings.length > 0,
    rows,
    tabularPreview: {
      sheetNames,
      selectedSheet: chosenSheet,
      headers,
      sampleRows,
      detectedMapping: mapping,
    },
  };
}
