import {
  type CategoryRule,
  type ClassificationRule,
  type CreditCard,
  type Direction,
  type EntityId,
  type Transaction,
  type TransactionStatus,
} from '../types';
import {
  cents,
  fromCents,
  getTransactionAmountCents,
  toCents,
  type MoneyCents,
} from '../domain/money/money';
import { addMonthsLocal, normalizeToIsoDate, todayLocal } from '../utils/dateUtils';
import { generateEntityId } from '../domain/common/id';
import { normalizeDescription } from '../utils/financeCalculations';
import { categorizeTransactionDescription } from '../domain/transactions/CategorizationService';
import { parseOfxStatement, decodeTextBuffer } from '../domain/extractions/parsers/ofxParser';
import { extractTextFromPdfBufferAsync } from '../domain/extractions/parsers/pdfAndImageParser';
import { detectBankFromStatement } from '../domain/extractions/banksRepository';
import {
  computeBillingCycleDates,
  type CardEntryKind,
} from '../domain/cards/CardLedgerService';
import {
  auditCardInvoiceDocument,
  cleanEstablishmentName,
  classifyAuditedCategory,
  fileOrBufferToBase64,
  INVOICE_AUDITOR_CATEGORIES,
  type AuditedInvoiceResult,
} from '../domain/cards/CardInvoiceAuditorService';
import {
  computeCardImportHash,
  normalizeCardMerchantForHash,
} from '../domain/cards/cardImportHash';

export type StatementImportFormat = 'PDF' | 'CSV' | 'OFX' | 'IMAGE';

export interface ImportedCardStatementRow {
  rowId: string;
  sourceRowIndex: number;
  date: string; // YYYY-MM-DD
  purchaseDate: string;
  postingDate: string;
  description: string; // Ex: "MAGALU LOJA X (02/10)"
  cleanDescription: string; // Ex: "MAGALU LOJA X"
  amountCents: MoneyCents;
  amount: number;
  direction: Direction;
  cardEntryKind: CardEntryKind;
  tipo: 'avista' | 'parcelada';
  installmentCurrent: number;
  installmentTotal: number;
  category: string;
  profile: EntityId; // 'CPF' | 'CNPJ'
  matchedRuleKeyword?: string;
  matchedRuleProfile?: EntityId;
  import_hash: string;
  idempotencyKey: string;
  alreadyImported: boolean;
  duplicateReason?: string;
  selected: boolean;
}

export interface StatementImportPreviewResult {
  format: StatementImportFormat;
  parseEngine: 'LOCAL_OFX' | 'LOCAL_CSV' | 'LOCAL_PDF_TEXT' | 'AI_OCR_FALLBACK';
  bankDetectedName?: string;
  dueDate: string | null;
  invoiceTotalCents: MoneyCents;
  reportedTotalCents: MoneyCents;
  newRowsCount: number;
  ignoredDuplicatesCount: number;
  ignoredAccountingLinesCount: number;
  projectedFutureInstallmentsCount: number;
  warnings: string[];
  rows: ImportedCardStatementRow[];
}

const ACCOUNTING_IGNORE_PATTERNS: RegExp[] = [
  /\bpagamento\s*(?:de\s*|da\s*)?fatura\b/i,
  /\bpgto\.?\s*(?:de\s*|da\s*)?fatura\b/i,
  /\bcr[eé]dito\s*(?:em\s*|de\s*|na\s*)?fatura\b/i,
  /\bcr[eé]dito\s*(?:de\s*)?pagamento\b/i,
  /\bpagamento\s*(?:recebido|efetuado|on-?line|fatura)\b/i,
  /\bsaldo\s*(?:anterior|em\s*aberto|rotativo|financiado)\b/i,
  /\bfatura\s*anterior\b/i,
  /\blimite\s*(?:total|dispon[ií]vel|de\s*cr[eé]dito|saque|parcelamento)\b/i,
  /\btotal\s*(?:da\s*)?fatura\b/i,
  /\bvalor\s*(?:total\s*)?(?:da\s*)?fatura\b/i,
  /\bpagamento\s*m[ií]nimo\b/i,
  /\bdeb\.?\s*autom[aá]tico\s*fatura\b/i,
  /\bsaldo\s*para\s*pr[oó]xim[ao]\s*fatura\b/i,
];

const KEEP_EVEN_IF_CONTAINS_CREDITO_PATTERNS: RegExp[] = [
  /\b(?:iof|tarifa|anuidade|estorno|reembolso|cashback|devolu[cç][aã]o|chargeback)\b/i,
];

/**
 * Filtro Contábil: ignora linhas de pagamento de fatura / crédito em fatura / saldo anterior
 * para evitar duplicidade com a aba Contas Bancárias.
 */
export function shouldIgnoreInvoiceAccountingLine(description: string): boolean {
  const clean = (description || '').trim();
  if (!clean) return true;

  // Preserva encargos e estornos legítimos de compras (desde que não seja "crédito em fatura" de pagamento)
  if (
    KEEP_EVEN_IF_CONTAINS_CREDITO_PATTERNS.some((re) => re.test(clean)) &&
    !/\b(?:pagamento|pgto)\s*(?:de\s*|da\s*)?fatura\b/i.test(clean)
  ) {
    return false;
  }

  return ACCOUNTING_IGNORE_PATTERNS.some((re) => re.test(clean));
}

const INSTALLMENT_DETECTION_REGEX = /(\d{1,2})\s*(?:-|\/|de)\s*(\d{1,2})/gi;
const STRICT_INSTALLMENT_REGEX = /(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})/gi;

/**
 * Detecta parcelas com regex (\d{1,2})\s*(?:/|de)\s*(\d{1,2}) (ex: 03/10, 3 de 10, PARC 02/12),
 * evitando falsos positivos com datas completas DD/MM/YYYY.
 */
export function detectInvoiceInstallment(
  description: string,
  explicitInstallmentCell?: string
): {
  tipo: 'avista' | 'parcelada';
  installmentCurrent: number;
  installmentTotal: number;
  cleanDescription: string;
} {
  const candidates = [explicitInstallmentCell || '', description || ''].filter(Boolean);

  for (const source of candidates) {
    const cleanSource = source.trim();
    // 1. Prioriza marcadores explícitos tipo PARC 03/10 ou 03 de 10
    const strictMatches = Array.from(cleanSource.matchAll(STRICT_INSTALLMENT_REGEX));
    for (let i = strictMatches.length - 1; i >= 0; i -= 1) {
      const m = strictMatches[i];
      const matchIndex = m.index ?? 0;
      const afterToken = cleanSource.slice(matchIndex + m[0].length);
      // Evita capturar DD/MM dentro de DD/MM/YYYY
      if (/^\s*\/\s*\d{2,4}/.test(afterToken)) continue;

      const cur = Number(m[1]);
      const tot = Number(m[2]);
      if (
        Number.isInteger(cur) &&
        Number.isInteger(tot) &&
        cur >= 1 &&
        tot >= 2 &&
        tot <= 48 &&
        cur <= tot
      ) {
        return {
          tipo: 'parcelada',
          installmentCurrent: cur,
          installmentTotal: tot,
          cleanDescription: cleanEstablishmentName(description),
        };
      }
    }

    // 2. Fallback para formato "PARCELA 03-10"
    const dashMatches = Array.from(cleanSource.matchAll(INSTALLMENT_DETECTION_REGEX));
    for (let i = dashMatches.length - 1; i >= 0; i -= 1) {
      const m = dashMatches[i];
      if (!/parc/i.test(cleanSource)) continue;
      const cur = Number(m[1]);
      const tot = Number(m[2]);
      if (cur >= 1 && tot >= 2 && tot <= 48 && cur <= tot) {
        return {
          tipo: 'parcelada',
          installmentCurrent: cur,
          installmentTotal: tot,
          cleanDescription: cleanEstablishmentName(description),
        };
      }
    }
  }

  return {
    tipo: 'avista',
    installmentCurrent: 1,
    installmentTotal: 1,
    cleanDescription: cleanEstablishmentName(description),
  };
}

const PT_MONTH_MAP: Record<string, string> = {
  jan: '01',
  janeiro: '01',
  fev: '02',
  fevereiro: '02',
  mar: '03',
  marco: '03',
  abr: '04',
  abril: '04',
  mai: '05',
  maio: '05',
  jun: '06',
  junho: '06',
  jul: '07',
  julho: '07',
  ago: '08',
  agosto: '08',
  set: '09',
  setembro: '09',
  out: '10',
  outubro: '10',
  nov: '11',
  novembro: '11',
  dez: '12',
  dezembro: '12',
};

function parseFlexibleCardDate(raw: string, fallbackYear: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  const iso = normalizeToIsoDate(trimmed);
  if (iso) return iso;

  // DD/MM/YY
  const ddmmyy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (ddmmyy) {
    return normalizeToIsoDate(`20${ddmmyy[3]}-${ddmmyy[2]}-${ddmmyy[1]}`);
  }

  // DD/MM
  const ddmm = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (ddmm) {
    const day = ddmm[1].padStart(2, '0');
    const month = ddmm[2].padStart(2, '0');
    return normalizeToIsoDate(`${fallbackYear}-${month}-${day}`);
  }

  // Nubank / Inter style: "14 NOV" or "14 nov 2026"
  const normMonth = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const ptMatch = normMonth.match(/^(\d{1,2})\s+(?:de\s+)?([a-z]{3,9})(?:\s+(?:de\s+)?(20\d{2}))?$/);
  if (ptMatch) {
    const monthNum = PT_MONTH_MAP[ptMatch[2]];
    if (monthNum) {
      const day = ptMatch[1].padStart(2, '0');
      const year = ptMatch[3] || fallbackYear;
      return normalizeToIsoDate(`${year}-${monthNum}-${day}`);
    }
  }

  return null;
}

function parseCardAmountNumber(raw: string): number | null {
  let cleaned = (raw || '').trim();
  if (!cleaned) return null;

  let trailingSign = 1;
  if (/\bC\b$/i.test(cleaned) || /\+$/.test(cleaned)) {
    // Em alguns PDFs de banco brasileiro, C indica crédito/estorno na fatura
    trailingSign = -1;
    cleaned = cleaned.replace(/(?:\s*C|\+)$/i, '').trim();
  } else if (/\bD\b$/i.test(cleaned)) {
    trailingSign = 1;
    cleaned = cleaned.replace(/\s*D$/i, '').trim();
  }

  const isParenNegative = /^\(.*\)$/.test(cleaned);
  cleaned = cleaned.replace(/[()R$\s]/gi, '').replace(/^'+/, '');
  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized = cleaned;
  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  const signed = isParenNegative ? -Math.abs(parsed) : parsed * trailingSign;
  return Number(signed.toFixed(2));
}

function splitCsvLineLocal(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

interface RawParsedInvoiceItem {
  date: string;
  description: string;
  amount: number; // positive = expense/charge, negative = reversal/refund
  explicitCategory?: string;
  explicitInstallment?: string;
  bankTransactionId?: string;
}

interface RawParsedInvoicePayload {
  bankDetectedName?: string;
  dueDate: string | null;
  reportedTotal: number;
  ignoredAccountingLinesCount: number;
  warnings: string[];
  items: RawParsedInvoiceItem[];
}

/**
 * Leitor local gratuito para CSV de faturas de cartão brasileiras:
 * Nubank (date,category,title,amount), Itaú, Bradesco, C6 Bank, Inter, Sicredi, Sicoob, BB.
 */
export function parseBrazilianCardInvoiceCsv(
  csvText: string,
  fileName = ''
): RawParsedInvoicePayload {
  const warnings: string[] = [];
  const cleanText = (csvText || '').replace(/^\uFEFF/, '');
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      bankDetectedName: undefined,
      dueDate: null,
      reportedTotal: 0,
      ignoredAccountingLinesCount: 0,
      warnings: ['Arquivo CSV vazio.'],
      items: [],
    };
  }

  const bankDetected = detectBankFromStatement(cleanText.slice(0, 2500), fileName);
  let detectedDueDate: string | null = null;
  let reportedTotal = 0;

  for (const line of lines.slice(0, 10)) {
    const dueMatch = line.match(/vencimento[^0-9]*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (dueMatch && !detectedDueDate) {
      detectedDueDate = normalizeToIsoDate(dueMatch[1]);
    }
    const totalMatch = line.match(
      /(?:total\s*(?:da\s*)?fatura|valor\s*total)[^0-9-]*([+-]?\s*(?:R\$)?\s*\d{1,3}(?:\.\d{3})*,\d{2}|[+-]?\d+\.\d{2})/i
    );
    if (totalMatch && reportedTotal === 0) {
      const n = parseCardAmountNumber(totalMatch[1]);
      if (n !== null && n > 0) reportedTotal = Math.abs(n);
    }
  }

  const sample = lines.slice(0, 8).join('\n');
  const semiCount = (sample.match(/;/g) || []).length;
  const commaCount = (sample.match(/,/g) || []).length;
  const tabCount = (sample.match(/\t/g) || []).length;
  const delimiter =
    tabCount > semiCount && tabCount > commaCount
      ? '\t'
      : semiCount >= commaCount
        ? ';'
        : ',';

  const matrix = lines.map((l) => splitCsvLineLocal(l, delimiter));

  let headerIdx = -1;
  let dateCol = -1;
  let descCol = -1;
  let amountCol = -1;
  let categoryCol = -1;
  let installmentCol = -1;
  let typeCol = -1;

  for (let r = 0; r < Math.min(12, matrix.length); r += 1) {
    const row = matrix[r];
    const lower = row.map((c) =>
      c
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
    );
    const dIdx = lower.findIndex((c) => /^(data|date|dt\b|data\s*da\s*compra|compra)/.test(c));
    const descIdx = lower.findIndex((c) =>
      /descri|estabelecimento|title|hist|lancamento|memo|merchant|compra/.test(c)
    );
    const valIdx = lower.findIndex((c) => /valor|amount|montante|preco|r\$/.test(c));
    const catIdx = lower.findIndex((c) => /categ|category/.test(c));
    const parcIdx = lower.findIndex((c) => /parcela|parc\b|installment/.test(c));
    const tpIdx = lower.findIndex((c) => /^tipo|natureza|d\/c|dc/.test(c));

    if (dIdx >= 0 && (descIdx >= 0 || valIdx >= 0)) {
      headerIdx = r;
      dateCol = dIdx;
      descCol = descIdx >= 0 ? descIdx : dIdx + 1;
      amountCol = valIdx >= 0 ? valIdx : row.length - 1;
      categoryCol = catIdx;
      installmentCol = parcIdx;
      typeCol = tpIdx;
      break;
    }
  }

  if (dateCol < 0) {
    const firstRow = matrix[0] || [];
    dateCol = firstRow.findIndex((c) => /\d{2}\/\d{2}|\d{4}-\d{2}-\d{2}/.test(c));
    amountCol = firstRow.findIndex((c) => /^-?\s*(?:R\$)?\s*[\d.,]+$/.test(c));
    if (dateCol < 0) dateCol = 0;
    if (amountCol < 0) amountCol = Math.max(1, firstRow.length - 1);
    descCol = firstRow.findIndex((_, idx) => idx !== dateCol && idx !== amountCol);
    if (descCol < 0) descCol = 1;
  }

  const currentYear = todayLocal().slice(0, 4);
  const rawCollected: Array<RawParsedInvoiceItem & { typeToken?: string }> = [];
  let ignoredAccountingLinesCount = 0;

  for (let r = headerIdx + 1; r < matrix.length; r += 1) {
    const row = matrix[r];
    if (!row || row.length < 2) continue;

    const rawDate = row[dateCol] || '';
    const isoDate = parseFlexibleCardDate(rawDate, currentYear);
    if (!isoDate) continue;

    const rawDesc = (row[descCol] || '').trim();
    if (!rawDesc) continue;
    if (shouldIgnoreInvoiceAccountingLine(rawDesc)) {
      ignoredAccountingLinesCount += 1;
      continue;
    }

    const rawVal = row[amountCol] || '';
    const numVal = parseCardAmountNumber(rawVal);
    if (numVal === null || numVal === 0) continue;

    const explicitCategory = categoryCol >= 0 ? (row[categoryCol] || '').trim() : undefined;
    const explicitInstallment =
      installmentCol >= 0 ? (row[installmentCol] || '').trim() : undefined;
    const typeToken = typeCol >= 0 ? (row[typeCol] || '').trim() : undefined;

    rawCollected.push({
      date: isoDate,
      description: rawDesc,
      amount: numVal,
      explicitCategory,
      explicitInstallment,
      typeToken,
    });
  }

  // Se o banco exportou todas as compras com sinal negativo (sem compras positivas), normaliza compras > 0
  const nonReversalTextRows = rawCollected.filter(
    (item) =>
      !/\b(estorno|reembolso|devolu[cç][aã]o|desconto|cr[eé]dito|cashback)\b/i.test(
        item.description
      )
  );
  const negNormalCount = nonReversalTextRows.filter((i) => i.amount < 0).length;
  const posNormalCount = nonReversalTextRows.filter((i) => i.amount > 0).length;
  const invertAllSigns = nonReversalTextRows.length >= 2 && posNormalCount === 0 && negNormalCount > 0;

  const items: RawParsedInvoiceItem[] = rawCollected.map((item) => {
    let val = invertAllSigns ? -item.amount : item.amount;
    if (
      /\b(estorno|reembolso|devolu[cç][aã]o|desconto\s*(?:na\s*)?fatura|cashback)\b/i.test(
        item.description
      ) ||
      (item.typeToken && /^c(?:red)?$/i.test(item.typeToken))
    ) {
      val = -Math.abs(val);
    }
    return {
      date: item.date,
      description: item.description,
      amount: Number(val.toFixed(2)),
      explicitCategory: item.explicitCategory,
      explicitInstallment: item.explicitInstallment,
    };
  });

  if (reportedTotal === 0) {
    reportedTotal = Math.max(
      0,
      Number(items.reduce((acc, i) => acc + i.amount, 0).toFixed(2))
    );
  }

  return {
    bankDetectedName:
      bankDetected.type !== 'desconhecido' ? bankDetected.name : undefined,
    dueDate: detectedDueDate,
    reportedTotal,
    ignoredAccountingLinesCount,
    warnings,
    items,
  };
}

/**
 * Leitor local gratuito para OFX de cartão de crédito brasileiro (<CCSTMTRS> ou <STMTRS>).
 * Converte a convenção OFX (compras negativas <TRNAMT>-150.00 / estornos positivos)
 * para o padrão de fatura de cartão (compras positivas, estornos negativos).
 */
export function parseBrazilianCardInvoiceOfx(
  ofxText: string,
  fileName = ''
): RawParsedInvoicePayload {
  const parsed = parseOfxStatement(ofxText, fileName);
  const warnings = [...parsed.warnings];
  let ignoredAccountingLinesCount = 0;

  // Detecta se é OFX padrão (compras negativas no cartão) vs positivo
  const nonPaymentRows = parsed.rows.filter(
    (r) => !shouldIgnoreInvoiceAccountingLine(r.description)
  );
  const negativeCount = nonPaymentRows.filter((r) => r.amountSignedCents < 0).length;
  const positiveCount = nonPaymentRows.filter((r) => r.amountSignedCents > 0).length;
  // No padrão OFX de cartão, compras vêm negativas; se maioria for negativa (ou arquivo tem CCSTMTRS e há negativos), inverte sinal
  const invertOfxSign = negativeCount >= positiveCount;

  const items: RawParsedInvoiceItem[] = [];
  for (const row of parsed.rows) {
    if (shouldIgnoreInvoiceAccountingLine(row.description)) {
      ignoredAccountingLinesCount += 1;
      continue;
    }
    if (!row.date || row.amountSignedCents === 0) continue;

    const rawFloat = (row.amountSignedCents as number) / 100;
    let amount = invertOfxSign ? -rawFloat : rawFloat;

    if (
      /\b(estorno|reembolso|devolu[cç][aã]o|desconto|cashback)\b/i.test(row.description)
    ) {
      amount = -Math.abs(amount);
    }

    items.push({
      date: row.date,
      description: row.description,
      amount: Number(amount.toFixed(2)),
      bankTransactionId: row.bankTransactionId,
    });
  }

  const reportedTotal =
    parsed.reportedEndingBalanceCents !== undefined && parsed.reportedEndingBalanceCents !== 0
      ? Math.abs((parsed.reportedEndingBalanceCents as number) / 100)
      : Math.max(
          0,
          Number(items.reduce((acc, i) => acc + i.amount, 0).toFixed(2))
        );

  return {
    bankDetectedName: parsed.identifiedAccount.bankName,
    dueDate: parsed.periodEnd || null,
    reportedTotal,
    ignoredAccountingLinesCount,
    warnings,
    items,
  };
}

const PDF_AMOUNT_TOKEN =
  '(?:[-+]?\\(?\\s*(?:R\\$\\s*)?\\d{1,3}(?:\\.\\d{3})*,\\d{2}\\)?(?:\\s*[CD])?|[-+]?\\(?\\s*(?:R\\$\\s*)?\\d+\\.\\d{2}\\)?(?:\\s*[CD])?)';
const PDF_SINGLE_TAIL_AMOUNT_RE = new RegExp(`(${PDF_AMOUNT_TOKEN})$`, 'i');
const PDF_DOUBLE_TAIL_AMOUNT_RE = new RegExp(
  `(${PDF_AMOUNT_TOKEN})\\s+(${PDF_AMOUNT_TOKEN})$`,
  'i'
);
const PDF_LINE_DATE_RE =
  /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{2,4}|\d{2}\/\d{2}|\d{1,2}\s+(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ))\b/i;

function inferPdfInvoiceYear(text: string): string {
  const dueOrFull = text.match(/\b\d{2}\/\d{2}\/(20\d{2})\b/);
  if (dueOrFull) return dueOrFull[1];
  const monthYear = text.match(/\b(?:0?[1-9]|1[0-2])\/(20\d{2})\b/);
  if (monthYear) return monthYear[1];
  const iso = text.match(/\b(20\d{2})-\d{2}-\d{2}\b/);
  if (iso) return iso[1];
  return todayLocal().slice(0, 4);
}

/**
 * Leitor textual gratuito para PDFs de faturas brasileiras (Nubank, Itaú, Bradesco, C6, Inter, Sicredi, Sicoob, BB).
 */
export function parseBrazilianCardInvoicePdfText(
  extractedText: string,
  fileName = ''
): RawParsedInvoicePayload {
  const cleanLines = (extractedText || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const inferredYear = inferPdfInvoiceYear(extractedText);
  const bankDetected = detectBankFromStatement(extractedText.slice(0, 3000), fileName);

  let detectedDueDate: string | null = null;
  let reportedTotal = 0;
  let ignoredAccountingLinesCount = 0;
  const items: RawParsedInvoiceItem[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < cleanLines.length; i += 1) {
    const line = cleanLines[i];
    if (/^p[aá]gina\s+\d+/i.test(line)) continue;

    if (!detectedDueDate && /vencimento/i.test(line)) {
      const m = line.match(/(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
      if (m) detectedDueDate = normalizeToIsoDate(m[1]);
    }
    if (
      reportedTotal === 0 &&
      /(?:total\s*(?:da\s*)?fatura|valor\s*(?:total\s*)?(?:da\s*)?fatura|o\s*valor\s*da\s*sua\s*fatura\s*[eé])/i.test(
        line
      )
    ) {
      const m = line.match(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+\.\d{2})/i);
      if (m) {
        const n = parseCardAmountNumber(m[1]);
        if (n !== null && n > 0) reportedTotal = Math.abs(n);
      }
    }

    const dateMatch = line.match(PDF_LINE_DATE_RE);
    if (!dateMatch) continue;

    const extractTailAmount = (
      target: string
    ): { amountToken: string; stripPattern: string } | null => {
      const dbl = target.match(PDF_DOUBLE_TAIL_AMOUNT_RE);
      if (dbl) return { amountToken: dbl[1], stripPattern: dbl[0] };
      const sgl = target.match(PDF_SINGLE_TAIL_AMOUNT_RE);
      if (sgl) return { amountToken: sgl[1], stripPattern: sgl[0] };
      return null;
    };

    let candidateLine = line;
    let tailAmt = extractTailAmount(line);

    if (!tailAmt && i + 1 < cleanLines.length) {
      const nextLine = cleanLines[i + 1];
      if (!PDF_LINE_DATE_RE.test(nextLine)) {
        const nextTail = extractTailAmount(nextLine);
        if (nextTail) {
          candidateLine = `${line} ${nextLine}`;
          tailAmt = nextTail;
          i += 1;
        }
      }
    }

    if (!tailAmt) continue;

    const parsedDate = parseFlexibleCardDate(dateMatch[1], inferredYear);
    const parsedAmt = parseCardAmountNumber(tailAmt.amountToken);
    if (!parsedDate || parsedAmt === null || parsedAmt === 0) continue;

    const descRaw = candidateLine
      .slice(dateMatch[0].length)
      .replace(tailAmt.stripPattern, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!descRaw) continue;

    if (shouldIgnoreInvoiceAccountingLine(descRaw)) {
      ignoredAccountingLinesCount += 1;
      continue;
    }

    const isReversalText =
      /\b(estorno|reembolso|devolu[cç][aã]o|desconto\s*(?:na\s*)?fatura|cashback)\b/i.test(descRaw);
    const normalizedVal = isReversalText ? -Math.abs(parsedAmt) : parsedAmt;

    const dedupKey = `${parsedDate}|${Math.round(normalizedVal * 100)}|${descRaw.toLowerCase()}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    items.push({
      date: parsedDate,
      description: descRaw,
      amount: normalizedVal,
    });
  }

  if (reportedTotal === 0 && items.length > 0) {
    reportedTotal = Math.max(
      0,
      Number(items.reduce((acc, item) => acc + item.amount, 0).toFixed(2))
    );
  }

  return {
    bankDetectedName: bankDetected.type !== 'desconhecido' ? bankDetected.name : undefined,
    dueDate: detectedDueDate,
    reportedTotal,
    ignoredAccountingLinesCount,
    warnings: [],
    items,
  };
}

/**
 * Cruza o estabelecimento com `classification_rules` (`categoryRules`) para preencher
 * automaticamente a Categoria (`category_id` / `category`) e o Perfil (`CPF` | `CNPJ`).
 */
export function matchClassificationRule(params: {
  description: string;
  rawDescription?: string;
  direction: Direction;
  cardId: string;
  defaultProfile: EntityId;
  rules: readonly ClassificationRule[];
  explicitCategory?: string;
}): {
  category: string;
  profile: EntityId;
  matchedRuleKeyword?: string;
  matchedRuleProfile?: EntityId;
} {
  const combinedDesc = [params.description, params.rawDescription].filter(Boolean).join(' ');
  const categorized = categorizeTransactionDescription({
    description: combinedDesc,
    direction: params.direction,
    customRules: [...params.rules],
    fallbackCategory: params.explicitCategory || 'Outros',
    cardId: params.cardId,
  });

  const resolvedProfile: EntityId =
    categorized.profile === 'CPF' || categorized.profile === 'CNPJ'
      ? categorized.profile
      : params.defaultProfile;

  // Se uma regra customizada casou, usa exatamente a categoria e perfil aprendidos
  if (categorized.isCustomRule) {
    return {
      category: categorized.category,
      profile: resolvedProfile,
      matchedRuleKeyword: categorized.matchedRuleKeyword,
      matchedRuleProfile: categorized.profile,
    };
  }

  const normalizedExplicit = params.explicitCategory?.trim();
  const auditorCat = classifyAuditedCategory(
    combinedDesc,
    normalizedExplicit &&
      (INVOICE_AUDITOR_CATEGORIES as readonly string[]).includes(normalizedExplicit)
      ? normalizedExplicit
      : undefined
  );

  // Prioriza categoria específica do cartão quando built-in retornou 'Outros'
  const category =
    categorized.category && categorized.category !== 'Outros'
      ? categorized.category
      : normalizedExplicit || auditorCat || 'Outros';

  return {
    category,
    profile: resolvedProfile,
    matchedRuleKeyword: categorized.matchedRuleKeyword,
  };
}

function detectFormatFromFile(fileName: string, mimeType: string): StatementImportFormat {
  const lower = (fileName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (lower.endsWith('.ofx') || mime.includes('ofx')) return 'OFX';
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || mime.includes('csv')) return 'CSV';
  if (lower.endsWith('.pdf') || mime.includes('pdf')) return 'PDF';
  return 'IMAGE';
}

function mapAuditedFallbackToRaw(audited: AuditedInvoiceResult): RawParsedInvoicePayload {
  return {
    dueDate: audited.resumo_fatura.vencimento,
    reportedTotal: audited.resumo_fatura.valor_total_identificado,
    ignoredAccountingLinesCount: 0,
    warnings: [],
    items: audited.transacoes.map((t) => ({
      date: t.data,
      description:
        t.total_parcelas > 1
          ? `${t.descricao} (${t.parcela_atual}/${t.total_parcelas})`
          : t.descricao,
      amount: t.valor,
      explicitCategory: t.categoria,
    })),
  };
}

/**
 * Orquestra a leitura gratuita (PDF / CSV / OFX) + filtro contábil + detecção de parcelas +
 * blindagem SHA-256 (`import_hash`) + auto-classificação (CPF/CNPJ & categoria).
 */
export async function importCardStatement(params: {
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
  card: CreditCard;
  existingTransactions: readonly Transaction[];
  classificationRules: readonly ClassificationRule[];
  allowAiFallback?: boolean;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StatementImportPreviewResult> {
  const {
    fileName,
    mimeType,
    buffer,
    card,
    existingTransactions,
    classificationRules,
    allowAiFallback = true,
    fetcher,
    signal,
  } = params;

  const format = detectFormatFromFile(fileName, mimeType);
  let parseEngine: StatementImportPreviewResult['parseEngine'] =
    format === 'OFX' ? 'LOCAL_OFX' : format === 'CSV' ? 'LOCAL_CSV' : 'LOCAL_PDF_TEXT';

  let rawPayload: RawParsedInvoicePayload;

  if (format === 'OFX') {
    const text = decodeTextBuffer(buffer);
    rawPayload = parseBrazilianCardInvoiceOfx(text, fileName);
  } else if (format === 'CSV') {
    const text = decodeTextBuffer(buffer);
    rawPayload = parseBrazilianCardInvoiceCsv(text, fileName);
  } else if (format === 'PDF') {
    const pdfExtract = await extractTextFromPdfBufferAsync(buffer);
    const localPdfParsed = parseBrazilianCardInvoicePdfText(pdfExtract.text, fileName);
    if (localPdfParsed.items.length > 0 || !allowAiFallback) {
      rawPayload = localPdfParsed;
      if (pdfExtract.pageLimitError) {
        rawPayload.warnings.push(pdfExtract.pageLimitError);
      }
    } else {
      parseEngine = 'AI_OCR_FALLBACK';
      const base64Data = await fileOrBufferToBase64(buffer);
      const audited = await auditCardInvoiceDocument({
        fileName,
        mimeType: mimeType || 'application/pdf',
        base64Data,
        fetcher,
        signal,
      });
      rawPayload = mapAuditedFallbackToRaw(audited);
      rawPayload.warnings.push(
        'PDF sem camada de texto estruturada: leitura realizada via auditor OCR.'
      );
    }
  } else {
    parseEngine = 'AI_OCR_FALLBACK';
    const base64Data = await fileOrBufferToBase64(buffer);
    const audited = await auditCardInvoiceDocument({
      fileName,
      mimeType: mimeType || 'image/png',
      base64Data,
      fetcher,
      signal,
    });
    rawPayload = mapAuditedFallbackToRaw(audited);
  }

  // Estruturas de deduplicação para blindagem SHA-256 por cartão
  const existingCardTxs = existingTransactions.filter(
    (t) =>
      t.status !== 'CANCELLED' &&
      (t.creditCardId === card.id || t.accountId === card.id)
  );
  const existingImportHashes = new Set<string>(
    existingCardTxs.map((t) => t.import_hash).filter(Boolean) as string[]
  );
  const existingLegacyKeys = new Set<string>(
    existingTransactions.map((t) => t.idempotencyKey).filter(Boolean) as string[]
  );
  const seenHashesInFile = new Set<string>();

  const rows: ImportedCardStatementRow[] = [];
  let invoiceTotalNumCents = 0;
  let ignoredDuplicatesCount = 0;
  let projectedFutureInstallmentsCount = 0;

  rawPayload.items.forEach((item, index) => {
    const isReversal = item.amount < 0;
    const isFee =
      !isReversal &&
      /\b(iof|tarifa|anuidade|juros|multa|encargo)\b/i.test(item.description);
    const direction: Direction = isReversal ? 'INCOME' : 'EXPENSE';
    const amountCents = toCents(Math.abs(item.amount));
    if (amountCents <= 0) return;

    const inst = detectInvoiceInstallment(item.description, item.explicitInstallment);
    const isInstallment = !isReversal && inst.tipo === 'parcelada' && inst.installmentTotal > 1;
    const cardEntryKind: CardEntryKind = isReversal
      ? 'REVERSAL'
      : isFee
        ? 'FEE'
        : isInstallment
          ? 'INSTALLMENT'
          : 'PURCHASE';

    const displayDesc = isInstallment
      ? `${inst.cleanDescription} (${inst.installmentCurrent}/${inst.installmentTotal})`
      : inst.cleanDescription;

    const importHash = computeCardImportHash({
      cardId: card.id,
      date: item.date,
      amountCents: amountCents as number,
      cleanDescription: inst.cleanDescription,
      direction,
    });

    const idempotencyKey = `sha256:${importHash}`;

    const cleanMerchantNorm = normalizeCardMerchantForHash(inst.cleanDescription);
    const dupBySha = existingImportHashes.has(importHash);
    const dupByIdemp = existingLegacyKeys.has(idempotencyKey);
    const dupByHeuristic = existingCardTxs.some((existing) => {
      if (existing.date !== item.date) return false;
      if (getTransactionAmountCents(existing) !== amountCents) return false;
      const existingNorm = normalizeCardMerchantForHash(
        existing.originalDescription || existing.description
      );
      return existingNorm === cleanMerchantNorm;
    });
    const dupInsideBatch = seenHashesInFile.has(importHash);
    seenHashesInFile.add(importHash);

    const alreadyImported = dupBySha || dupByIdemp || dupByHeuristic || dupInsideBatch;

    if (alreadyImported) {
      ignoredDuplicatesCount += 1;
    } else if (isInstallment && inst.installmentCurrent < inst.installmentTotal) {
      projectedFutureInstallmentsCount += inst.installmentTotal - inst.installmentCurrent;
    }

    invoiceTotalNumCents += isReversal ? -(amountCents as number) : (amountCents as number);

    const classification = matchClassificationRule({
      description: inst.cleanDescription,
      rawDescription: item.description,
      direction,
      cardId: card.id,
      defaultProfile: card.entityId,
      rules: classificationRules,
      explicitCategory: item.explicitCategory,
    });

    rows.push({
      rowId: generateEntityId('impcard'),
      sourceRowIndex: index + 1,
      date: item.date,
      purchaseDate: item.date,
      postingDate: item.date,
      description: displayDesc,
      cleanDescription: inst.cleanDescription,
      amountCents,
      amount: fromCents(amountCents),
      direction,
      cardEntryKind,
      tipo: isInstallment ? 'parcelada' : 'avista',
      installmentCurrent: isInstallment ? inst.installmentCurrent : 1,
      installmentTotal: isInstallment ? inst.installmentTotal : 1,
      category: classification.category,
      profile: classification.profile,
      matchedRuleKeyword: classification.matchedRuleKeyword,
      matchedRuleProfile: classification.matchedRuleProfile,
      import_hash: importHash,
      idempotencyKey,
      alreadyImported,
      duplicateReason: dupBySha || dupByIdemp
        ? 'Já importado (SHA-256 idempotente)'
        : dupByHeuristic
          ? 'Lançamento equivalente já existe neste cartão'
          : dupInsideBatch
            ? 'Linha duplicada no mesmo arquivo'
            : undefined,
      selected: !alreadyImported,
    });
  });

  const computedTotalCents = cents(Math.max(0, invoiceTotalNumCents));
  const reportedTotalCents =
    rawPayload.reportedTotal > 0 ? toCents(rawPayload.reportedTotal) : computedTotalCents;

  return {
    format,
    parseEngine,
    bankDetectedName: rawPayload.bankDetectedName,
    dueDate: rawPayload.dueDate,
    invoiceTotalCents: computedTotalCents,
    reportedTotalCents,
    newRowsCount: rows.filter((r) => !r.alreadyImported).length,
    ignoredDuplicatesCount,
    ignoredAccountingLinesCount: rawPayload.ignoredAccountingLinesCount,
    projectedFutureInstallmentsCount,
    warnings: rawPayload.warnings,
    rows,
  };
}

/**
 * Converte as linhas revisadas no modal em lançamentos prontos para persistência,
 * conectando compras parceladas ao motor de ciclos (`computeBillingCycleDates`)
 * para lançar a parcela atual e projetar automaticamente as parcelas futuras.
 */
export function buildImportedCardTransactions(params: {
  rows: readonly ImportedCardStatementRow[];
  targetCard: CreditCard;
  importBatchId: string;
  generateFutureInstallments?: boolean;
  existingTransactions?: readonly Transaction[];
}): Omit<Transaction, 'id'>[] {
  const {
    rows,
    targetCard,
    importBatchId,
    generateFutureInstallments = true,
    existingTransactions = [],
  } = params;

  const existingHashes = new Set<string>(
    existingTransactions.map((t) => t.import_hash).filter(Boolean) as string[]
  );
  const existingKeys = new Set<string>(
    existingTransactions.map((t) => t.idempotencyKey).filter(Boolean) as string[]
  );
  const existingTupleKeys = new Set<string>();
  for (const t of existingTransactions) {
    if (t.status === 'CANCELLED') continue;
    if (t.creditCardId === targetCard.id && t.installmentCurrent && t.installmentTotal) {
      const cleanExisting = normalizeCardMerchantForHash(
        t.originalDescription || t.description
      ).replace(/\s+/g, '');
      existingTupleKeys.add(
        `${targetCard.id}|${getTransactionAmountCents(t)}|${cleanExisting}|${t.installmentCurrent}/${t.installmentTotal}`
      );
    }
  }

  const out: Omit<Transaction, 'id'>[] = [];

  for (const row of rows) {
    if (row.alreadyImported || !row.selected || row.amountCents <= 0) continue;
    if (existingHashes.has(row.import_hash) || existingKeys.has(row.idempotencyKey)) {
      continue;
    }

    existingHashes.add(row.import_hash);
    existingKeys.add(row.idempotencyKey);

    const baseDate = row.postingDate || row.date;
    const baseCycle = computeBillingCycleDates(
      baseDate,
      targetCard.closingDay,
      targetCard.dueDay
    );
    const isInstallment =
      row.cardEntryKind === 'INSTALLMENT' && row.installmentTotal > 1;
    const curParc = Math.max(1, row.installmentCurrent || 1);
    const totParc = Math.max(1, row.installmentTotal || 1);
    const groupId = isInstallment ? generateEntityId('cinst-imp') : undefined;
    const resolvedEntity: EntityId = row.profile || targetCard.entityId;

    out.push({
      entityId: resolvedEntity,
      accountId: targetCard.id,
      creditCardId: targetCard.id,
      date: baseDate,
      purchaseDate: row.purchaseDate || baseDate,
      postingDate: baseDate,
      billingCycleYm: baseCycle.cycleYm,
      billingClosingDate: baseCycle.closingDate,
      billingDueDate: baseCycle.dueDate,
      cardEntryKind: row.cardEntryKind,
      ...(groupId ? { installmentGroupId: groupId } : {}),
      ...(isInstallment
        ? { installmentCurrent: curParc, installmentTotal: totParc }
        : {}),
      description: row.description,
      originalDescription: row.cleanDescription,
      category: row.category || 'Outros',
      account: `${targetCard.institutionName} · ${targetCard.cardName}`,
      amountCents: row.amountCents,
      amount: fromCents(row.amountCents),
      direction: row.direction,
      status: 'CONFIRMED' as TransactionStatus,
      origin: 'IMPORT',
      operationType: row.cardEntryKind === 'FEE' ? 'TARIFA' : 'CARTAO',
      counterparty: row.cleanDescription,
      importBatchId,
      idempotencyKey: row.idempotencyKey,
      import_hash: row.import_hash,
    });

    if (generateFutureInstallments && isInstallment && curParc < totParc && groupId) {
      const purchaseOriginalDate = addMonthsLocal(baseDate, -(curParc - 1));
      const cleanNormNoSpace = normalizeCardMerchantForHash(row.cleanDescription).replace(
        /\s+/g,
        ''
      );

      for (let nextParc = curParc + 1; nextParc <= totParc; nextParc += 1) {
        const monthOffset = nextParc - curParc;
        const futurePostingDate = addMonthsLocal(baseDate, monthOffset);
        const futureCycle = computeBillingCycleDates(
          futurePostingDate,
          targetCard.closingDay,
          targetCard.dueDay
        );

        const futureHash = computeCardImportHash({
          cardId: targetCard.id,
          date: futurePostingDate,
          amountCents: row.amountCents as number,
          cleanDescription: `${row.cleanDescription} ${nextParc}/${totParc}`,
          direction: 'EXPENSE',
        });
        const futureKey = `sha256:${futureHash}`;
        const tupleKey = `${targetCard.id}|${row.amountCents}|${cleanNormNoSpace}|${nextParc}/${totParc}`;

        if (
          existingHashes.has(futureHash) ||
          existingKeys.has(futureKey) ||
          existingTupleKeys.has(tupleKey)
        ) {
          continue;
        }

        existingHashes.add(futureHash);
        existingKeys.add(futureKey);
        existingTupleKeys.add(tupleKey);

        out.push({
          entityId: resolvedEntity,
          accountId: targetCard.id,
          creditCardId: targetCard.id,
          date: futurePostingDate,
          purchaseDate: purchaseOriginalDate,
          postingDate: futurePostingDate,
          billingCycleYm: futureCycle.cycleYm,
          billingClosingDate: futureCycle.closingDate,
          billingDueDate: futureCycle.dueDate,
          cardEntryKind: 'INSTALLMENT',
          installmentGroupId: groupId,
          installmentCurrent: nextParc,
          installmentTotal: totParc,
          description: `${row.cleanDescription} (${nextParc}/${totParc})`,
          originalDescription: row.cleanDescription,
          category: row.category || 'Outros',
          account: `${targetCard.institutionName} · ${targetCard.cardName}`,
          amountCents: row.amountCents,
          amount: fromCents(row.amountCents),
          direction: 'EXPENSE',
          status: 'PENDING',
          origin: 'IMPORT',
          operationType: 'CARTAO',
          counterparty: row.cleanDescription,
          importBatchId,
          idempotencyKey: futureKey,
          import_hash: futureHash,
        });
      }
    }
  }

  return out;
}

/**
 * Gera novas `classification_rules` (`CategoryRule`) a partir das revisões confirmadas
 * pelo usuário no modal de fatura, permitindo auto-classificação nas próximas faturas.
 */
export function buildLearnedClassificationRules(params: {
  rows: ReadonlyArray<{
    cleanDescription?: string;
    description: string;
    category: string;
    profile?: EntityId;
    direction?: Direction;
    selected?: boolean;
    alreadyImported?: boolean;
    isDuplicate?: boolean;
  }>;
  cardId?: string;
  existingRules: readonly ClassificationRule[];
}): ClassificationRule[] {
  const nowIso = new Date().toISOString();
  const learnedMap = new Map<string, ClassificationRule>();

  // Mantém índice das regras existentes por keyword normalizada + card_id
  const existingByKey = new Map<string, ClassificationRule>();
  for (const r of params.existingRules) {
    const key = `${normalizeDescription(r.keyword)}|${r.card_id || ''}`;
    existingByKey.set(key, r);
  }

  for (const row of params.rows) {
    if (row.selected === false || row.alreadyImported || row.isDuplicate) continue;
    const rawClean = (row.cleanDescription || cleanEstablishmentName(row.description)).trim();
    const keywordNorm = normalizeDescription(rawClean);
    if (!keywordNorm || keywordNorm.length < 3) continue;
    // Evita criar regra genérica para categorias não decididas sem perfil específico
    if (row.category === 'Outros' && !row.profile) continue;

    // Usa um prefixo/estabelecimento limpo até 40 caracteres como palavra-chave
    const keyword = rawClean.slice(0, 40).trim();
    const mapKey = `${normalizeDescription(keyword)}|${params.cardId || ''}`;
    const existing = existingByKey.get(mapKey);
    const resolvedProfile: EntityId = row.profile || 'CPF';

    if (
      existing &&
      existing.category === row.category &&
      (existing.profile || existing.entityId) === resolvedProfile
    ) {
      continue;
    }

    learnedMap.set(mapKey, {
      id: existing?.id || generateEntityId('crule'),
      keyword,
      category: row.category,
      category_id: row.category,
      profile: resolvedProfile,
      entityId: resolvedProfile,
      ...(params.cardId ? { card_id: params.cardId } : {}),
      ...(row.direction ? { direction: row.direction } : {}),
      createdAt: existing?.createdAt || nowIso,
    });
  }

  return Array.from(learnedMap.values());
}
