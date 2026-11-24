import { toCents } from '../../money/money';
import type { MoneyCents } from '../../money/money';
import type { CsvColumnMapping, ParseResultPayload } from '../../../types-sub/extractions';
import {
  sanitizeExtractedText,
  sanitizeRawRowSnapshot,
} from '../fileSecurity';
import { normalizeCompeCode } from '../banksRepository';
import {
  detectStatementProfile,
  extractStatementHolderMetadata,
} from '../bankStatementProfiles';
import {
  detectCsvDelimiter,
  inferColumnMappingFromHeaders,
  inferExtendedTabularHints,
  normalizeTransactionIdToken,
  parseFlexibleDate,
  parseFlexibleSignedAmount,
  splitCsvLine,
} from './tabularPrimitives';

function decodeOfxEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

function extractOfxTagValue(block: string, tag: string): string | undefined {
  const xmlRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const xmlMatch = block.match(xmlRegex);
  if (xmlMatch?.[1]?.trim()) {
    return sanitizeExtractedText(decodeOfxEntities(xmlMatch[1]), 240);
  }
  const sgmlRegex = new RegExp(`<${tag}>([^\\r\\n<]+)`, 'i');
  const sgmlMatch = block.match(sgmlRegex);
  if (sgmlMatch?.[1]?.trim()) {
    return sanitizeExtractedText(decodeOfxEntities(sgmlMatch[1]), 240);
  }
  return undefined;
}

function parseOfxDateIso(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return undefined;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const yNum = Number(year);
  const mNum = Number(month);
  const dNum = Number(day);
  if (yNum < 1990 || yNum > 2100 || mNum < 1 || mNum > 12 || dNum < 1 || dNum > 31) {
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

function parseOfxNumericAmount(raw?: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/\s+/g, '');
  const normalized =
    cleaned.includes(',') && cleaned.includes('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : undefined;
}

export function extractBancoDoBrasilStructuredId(text?: string): string | undefined {
  const raw = String(text || '').trim();
  if (!raw) return undefined;

  // 1. Bacen Pix End-to-End ID (E + 8 ISPB + 12 datetime + 11 alphanumeric = 32 chars)
  const e2eMatch = raw.match(/\b(E\d{8}\d{12}[A-Za-z0-9]{11})\b/);
  if (e2eMatch?.[1]) {
    return e2eMatch[1];
  }

  // 2. Explicit NSU / Autenticação / Protocolo / Documento labeled inside Detalhes or MEMO
  const labeledMatch = raw.match(
    /(?:autenticac[aã]o|protocolo|nsu|id\s*transac[aã]o|cod\.?\s*autenticac[aã]o)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9.-]{4,35})/i
  );
  if (labeledMatch?.[1]) {
    const token = normalizeTransactionIdToken(labeledMatch[1]);
    if (token && !/^\d{2}[./-]\d{2}(?:[./-]\d{2,4})?$/.test(token)) {
      return token;
    }
  }

  const docMatch = raw.match(
    /(?:n[ºo°.]*\s*doc(?:umento)?|nro\.?\s*doc\.?|num\.?\s*doc\.?|doc(?:umento)?)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9.-]{3,23})/i
  );
  if (docMatch?.[1]) {
    const token = normalizeTransactionIdToken(docMatch[1]);
    if (token && !/^\d{2}[./-]\d{2}(?:[./-]\d{2,4})?$/.test(token)) {
      return token;
    }
  }

  return undefined;
}

export function isBancoDoBrasilOfx(rawContent: string, fileName = ''): boolean {
  if (!rawContent || !/<OFX>|<STMTTRN>|OFXHEADER|<BANKID>|<BANKACCTFROM>/i.test(rawContent)) {
    return false;
  }

  const headerSlice = rawContent.slice(0, 12000);
  const sonrsBlock = rawContent.match(/<SONRS>[\s\S]*?<\/SONRS>/i)?.[0] || '';
  const acctBlock =
    rawContent.match(/<(?:BANKACCTFROM|CCACCTFROM)>[\s\S]*?(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|<BANKTRANLIST>|$)/i)?.[0] ||
    '';
  const metaScope = [headerSlice, sonrsBlock, acctBlock].join('\n');

  const bankIdRaw = extractOfxTagValue(metaScope, 'BANKID');
  const fidRaw = extractOfxTagValue(metaScope, 'FID');
  const orgRaw = extractOfxTagValue(metaScope, 'ORG') || '';

  const bankCompe = normalizeCompeCode(bankIdRaw);
  const fidCompe = normalizeCompeCode(fidRaw);

  // If an explicit non-BB COMPE code is declared in BANKID, never hijack another bank's OFX
  if (bankCompe && bankCompe !== '001') {
    return false;
  }

  if (bankCompe === '001' || fidCompe === '001') {
    return true;
  }

  if (
    /banco\s*do\s*brasil|\bbco\s*(?:do\s*)?brasil\b|\bgerenciador\s*financeiro\b|\bourocard\b/i.test(
      orgRaw
    )
  ) {
    return true;
  }

  const normalizedFile = fileName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /(?:banco[\s_-]*do[\s_-]*brasil|(?:^|[\s_-])bb(?:[\s_-]|$))/i.test(normalizedFile) && !bankCompe;
}

export function isBancoDoBrasilCsv(params: {
  headers: string[];
  leadingMetaLines: string[];
  rawTextSample: string;
  fileName?: string;
}): boolean {
  const detection = detectStatementProfile({
    format: 'CSV',
    headers: params.headers,
    headerLines: params.leadingMetaLines,
    rawTextSample: params.rawTextSample,
    fileName: params.fileName,
  });
  return detection.profileId === 'bb_csv';
}

export function parseBancoDoBrasilOfx(rawContent: string, fileName = ''): ParseResultPayload {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!rawContent || !rawContent.trim()) {
    return {
      format: 'OFX',
      parseSource: 'LOCAL',
      identifiedAccount: {
        bankName: 'Banco do Brasil',
        bankCode: '001',
        bankIspb: '00000000',
        bankType: 'fisico',
        institutionId: 'inst-bb',
        institutionCategory: 'BANCO_FISICO',
        detectedStatementProfile: 'bb_ofx',
        requiresConfirmation: true,
        confirmationReason: 'Arquivo OFX do Banco do Brasil vazio.',
      },
      warnings,
      errors: ['Arquivo OFX vazio ou ilegível.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  const tranListIdx = rawContent.search(/<BANKTRANLIST>/i);
  const ofxHeaderBlock =
    tranListIdx > 0 ? rawContent.slice(0, tranListIdx) : rawContent.slice(0, 8000);
  const sonrsBlock = rawContent.match(/<SONRS>[\s\S]*?<\/SONRS>/i)?.[0] || '';
  const acctBlock =
    rawContent.match(
      /<(?:BANKACCTFROM|CCACCTFROM)>[\s\S]*?(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|<BANKTRANLIST>|$)/i
    )?.[0] || '';
  const fullMetaScope = [ofxHeaderBlock, sonrsBlock, acctBlock].filter(Boolean).join('\n');

  const rawBankId =
    extractOfxTagValue(fullMetaScope, 'BANKID') || extractOfxTagValue(fullMetaScope, 'FID');
  const normalizedBankCode = normalizeCompeCode(rawBankId) || '001';
  const org = extractOfxTagValue(fullMetaScope, 'ORG') || 'Banco do Brasil';
  const acctId = extractOfxTagValue(acctBlock || fullMetaScope, 'ACCTID');
  const acctType = extractOfxTagValue(acctBlock || fullMetaScope, 'ACCTTYPE');
  const branchId = extractOfxTagValue(acctBlock || fullMetaScope, 'BRANCHID');
  const acctHolderName =
    extractOfxTagValue(acctBlock || fullMetaScope, 'ACCTNAME') ||
    extractOfxTagValue(sonrsBlock || fullMetaScope, 'NAME');
  const currency = (extractOfxTagValue(fullMetaScope, 'CURDEF') || 'BRL').toUpperCase();
  const dtStart = parseOfxDateIso(extractOfxTagValue(rawContent, 'DTSTART'));
  const dtEnd = parseOfxDateIso(extractOfxTagValue(rawContent, 'DTEND'));

  const ledgerBlock =
    rawContent.match(/<LEDGERBAL>[\s\S]*?(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i)?.[0] ||
    '';
  const availBlock =
    rawContent.match(/<AVAILBAL>[\s\S]*?(?:<\/AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i)?.[0] || '';
  const ledgerAmt = parseOfxNumericAmount(extractOfxTagValue(ledgerBlock, 'BALAMT'));
  const availAmt = parseOfxNumericAmount(extractOfxTagValue(availBlock, 'BALAMT'));

  if (ledgerAmt === undefined) {
    warnings.push(
      'O arquivo OFX do Banco do Brasil não informou saldo final (<LEDGERBAL>). Conciliação de saldo ficará pendente de conferência.'
    );
  }

  const rawBlocks = rawContent.split(/<STMTTRN>/i).slice(1);
  if (rawBlocks.length === 0) {
    warnings.push('Nenhuma movimentação (<STMTTRN>) encontrada neste arquivo OFX.');
  }

  interface PreParsedOfxBlock {
    idx: number;
    dtPosted?: string;
    dtUser?: string;
    amtNum?: number;
    trnType?: string;
    rawFitId?: string;
    fitId?: string;
    checkNum?: string;
    refNum?: string;
    memo?: string;
    name?: string;
    sig: string;
  }

  const preParsed: PreParsedOfxBlock[] = rawBlocks.map((rawBlock, idx) => {
    const endIdx = rawBlock.search(/<\/STMTTRN>/i);
    const block = endIdx >= 0 ? rawBlock.slice(0, endIdx) : rawBlock;

    const dtPosted = parseOfxDateIso(extractOfxTagValue(block, 'DTPOSTED'));
    const dtUser = parseOfxDateIso(extractOfxTagValue(block, 'DTUSER'));
    const amtNum = parseOfxNumericAmount(extractOfxTagValue(block, 'TRNAMT'));
    const trnType = extractOfxTagValue(block, 'TRNTYPE');
    const rawFitId = extractOfxTagValue(block, 'FITID');
    const fitId = normalizeTransactionIdToken(rawFitId);
    const checkNum = normalizeTransactionIdToken(extractOfxTagValue(block, 'CHECKNUM'));
    const refNum = normalizeTransactionIdToken(extractOfxTagValue(block, 'REFNUM'));
    const memo = extractOfxTagValue(block, 'MEMO');
    const name = extractOfxTagValue(block, 'NAME');

    const sig = `${dtPosted || dtUser || ''}|${amtNum ?? ''}|${(name || '').toLowerCase()}|${(memo || '').toLowerCase()}`;
    return {
      idx,
      dtPosted,
      dtUser,
      amtNum,
      trnType,
      rawFitId,
      fitId,
      checkNum,
      refNum,
      memo,
      name,
      sig,
    };
  });

  // Detect degenerate BB OFX FITIDs (same FITID assigned to distinct transactions with different amount/desc/date)
  const fitIdSignatures = new Map<string, Set<string>>();
  for (const item of preParsed) {
    if (!item.fitId || item.amtNum === undefined || item.amtNum === 0) continue;
    const set = fitIdSignatures.get(item.fitId) || new Set<string>();
    set.add(item.sig);
    fitIdSignatures.set(item.fitId, set);
  }
  const degenerateFitIds = new Set<string>();
  for (const [id, sigSet] of fitIdSignatures.entries()) {
    if (sigSet.size > 1) {
      degenerateFitIds.add(id);
    }
  }

  const rows: ParseResultPayload['rows'] = [];
  let missingIdCount = 0;

  for (const item of preParsed) {
    if (item.amtNum === undefined || item.amtNum === 0) {
      warnings.push(`Bloco OFX #${item.idx + 1} ignorado por valor ausente ou zerado.`);
      continue;
    }

    if (!item.dtPosted && !item.dtUser) {
      warnings.push(
        `Movimentação "${item.memo || item.name || `#${item.idx + 1}`}" sem data válida no OFX; revisão necessária.`
      );
    }

    const combinedDesc =
      [item.name, item.memo]
        .filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i)
        .join(' · ') || 'Movimento Banco do Brasil OFX';

    const usableFitId =
      item.fitId && !degenerateFitIds.has(item.fitId) ? item.fitId : undefined;
    const structuredMemoId = extractBancoDoBrasilStructuredId(
      `${item.name || ''} ${item.memo || ''}`
    );
    const resolvedTxId =
      usableFitId || item.checkNum || item.refNum || structuredMemoId || undefined;

    if (!resolvedTxId) {
      missingIdCount += 1;
    }

    const signedCents = (Math.round(item.amtNum * 100) as MoneyCents) || toCents(item.amtNum);

    rows.push({
      date: item.dtUser || item.dtPosted || dtEnd || dtStart || '',
      postedDate: item.dtPosted,
      description: combinedDesc,
      amountSignedCents: signedCents,
      currency,
      bankTransactionId: resolvedTxId,
      rawOperationHint: item.trnType,
      rawRowSnapshot: sanitizeRawRowSnapshot({
        TRNTYPE: item.trnType || '',
        DTPOSTED: item.dtPosted || '',
        TRNAMT: item.amtNum,
        FITID: item.rawFitId || '',
        CHECKNUM: item.checkNum || '',
        REFNUM: item.refNum || '',
        NAME: item.name || '',
        MEMO: item.memo || '',
      }),
      confidence: item.dtPosted && resolvedTxId ? 0.97 : 0.82,
      doubtReason: !item.dtPosted
        ? 'Data da operação ausente no arquivo OFX.'
        : !resolvedTxId
          ? 'Sem identificador bancário único (FITID/Documento); conferência recomendada.'
          : undefined,
    });
  }

  if (missingIdCount > 0) {
    warnings.push(
      `${missingIdCount} lançamento(s) OFX do Banco do Brasil sem identificador único nativo (FITID/N° documento).`
    );
  }

  const holderMeta = extractStatementHolderMetadata({
    headerText: fullMetaScope,
    bankCode: normalizedBankCode,
    institutionId: 'inst-bb',
    ofxBranchId: branchId,
    ofxAcctId: acctId,
    ofxAcctType: acctType,
    ofxOrg: org,
  });

  if (!holderMeta.rawAccountNumberDigits && !acctId) {
    warnings.push(
      'Identificador da conta (<ACCTID>) não encontrado no OFX. Selecione ou confirme a conta manualmente.'
    );
  }
  if (holderMeta.hasConflictingTaxDocuments && holderMeta.conflictReason) {
    warnings.push(holderMeta.conflictReason);
  }

  const reportedEndingBalanceCents =
    ledgerAmt !== undefined ? (Math.round(ledgerAmt * 100) as MoneyCents) : undefined;
  const availableBalanceCents =
    availAmt !== undefined ? (Math.round(availAmt * 100) as MoneyCents) : undefined;

  return {
    format: 'OFX',
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName: 'Banco do Brasil',
      bankCode: normalizedBankCode,
      bankIspb: '00000000',
      bankType: 'fisico',
      detectionConfidence: 'alta',
      institutionId: 'inst-bb',
      institutionCategory: 'BANCO_FISICO',
      detectedStatementProfile: 'bb_ofx',
      accountProfileId: holderMeta.accountProfileId,
      accountProfileLabel: holderMeta.accountProfileLabel,
      maskedDocument: holderMeta.maskedDocument,
      documentValid: holderMeta.documentValid,
      holderNature: holderMeta.holderNature,
      agency: holderMeta.agency,
      rawAccountNumberDigits: holderMeta.rawAccountNumberDigits,
      maskedAccountNumber: holderMeta.maskedAccountNumber,
      holderName: holderMeta.holderName || acctHolderName,
      companyName:
        holderMeta.companyName ||
        (holderMeta.holderNature === 'CNPJ' ? acctHolderName : undefined),
      accountType: holderMeta.accountType || acctType,
      currency,
      requiresConfirmation: true,
      confirmationReason:
        holderMeta.conflictReason ||
        (!holderMeta.holderNature
          ? 'Documento CPF/CNPJ do titular não consta no cabeçalho OFX. Confirme a titularidade e conta.'
          : 'Confirme a associação da conta Banco do Brasil identificada antes de efetivar lançamentos.'),
    },
    periodStart: dtStart,
    periodEnd: dtEnd,
    reportedEndingBalanceCents,
    availableBalanceCents,
    warnings,
    errors,
    requiresManualReview: rows.some((r) => Boolean(r.doubtReason)) || warnings.length > 0,
    rows,
  };
}

function scoreBbHeaderCandidate(cols: string[]): number {
  if (cols.length < 3) return -1;
  const norm = cols.map((c) =>
    c
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
  );

  let score = 0;
  if (norm.some((c) => /^data$/.test(c))) score += 4;
  else if (norm.some((c) => /\bdata\b/.test(c) && c.length <= 24)) score += 2;

  if (norm.some((c) => /^lancamento$|^historico$/.test(c))) score += 4;
  else if (norm.some((c) => /hist|lancamento|desc/.test(c) && c.length <= 28)) score += 2;

  if (norm.some((c) => /^detalhes?$/.test(c))) score += 3;
  if (
    norm.some((c) =>
      /n[ºo°?.\s]*doc(?:umento)?|numero\s*(?:do\s*)?documento|nr\.?\s*doc(?:umento)?|num\.?\s*doc(?:umento)?|^documento$/.test(
        c
      )
    )
  ) {
    score += 4;
  }
  if (norm.some((c) => /^valor(?:\s*r\$)?$/.test(c))) score += 4;
  else if (norm.some((c) => /valor|debito|credito/.test(c) && c.length <= 24)) score += 2;

  if (norm.some((c) => /tipo\s*(?:de\s*)?lancamento|^d\/c$|^inf\.?$/.test(c))) score += 3;
  if (norm.some((c) => /dependencia\s*origem|data\s*(?:do\s*)?balancete/.test(c))) score += 3;

  // Penalize obvious metadata key-value rows (e.g. "Data emissão: 10/11/2026")
  if (cols.some((c) => /\d{2}\/\d{2}\/\d{4}/.test(c) || c.includes(':'))) {
    score -= 4;
  }

  return score;
}

function resolveBalanceRowAmount(
  cols: string[],
  mapping: CsvColumnMapping,
  signIndicatorCol?: number
): number | undefined {
  let bal: number | undefined;

  if (mapping.balanceCol !== undefined) {
    bal = parseFlexibleSignedAmount(cols[mapping.balanceCol]);
  }
  if (bal === undefined && mapping.amountCol !== undefined) {
    bal = parseFlexibleSignedAmount(cols[mapping.amountCol]);
  }
  if (bal === undefined) {
    for (let c = cols.length - 1; c >= 0; c--) {
      if (c === mapping.dateCol || c === mapping.idCol || c === signIndicatorCol) continue;
      const parsed = parseFlexibleSignedAmount(cols[c]);
      if (parsed !== undefined) {
        bal = parsed;
        break;
      }
    }
  }

  if (bal !== undefined && signIndicatorCol !== undefined) {
    const signRaw = (cols[signIndicatorCol] || '')
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (/^(D|DEB|DEBITO|SAIDA|-)$/.test(signRaw)) {
      bal = -Math.abs(bal);
    } else if (/^(C|CRED|CREDITO|ENTRADA|\+)$/.test(signRaw)) {
      bal = Math.abs(bal);
    }
  }

  return bal;
}

export function parseBancoDoBrasilCsv(
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
      identifiedAccount: {
        bankName: 'Banco do Brasil',
        bankCode: '001',
        bankIspb: '00000000',
        bankType: 'fisico',
        institutionId: 'inst-bb',
        institutionCategory: 'BANCO_FISICO',
        detectedStatementProfile: 'bb_csv',
        requiresConfirmation: true,
        confirmationReason: 'Arquivo CSV do Banco do Brasil vazio.',
      },
      warnings,
      errors: ['O arquivo CSV está vazio.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  const delimiter = explicitMapping?.delimiter || detectCsvDelimiter(allLines);
  let headerIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(20, allLines.length); i++) {
    const cols = splitCsvLine(allLines[i], delimiter);
    const score = scoreBbHeaderCandidate(cols);
    if (score > bestScore && score >= 6) {
      bestScore = score;
      headerIdx = i;
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
      const b = resolveBalanceRowAmount(metaCols, mapping, hints.signIndicatorCol);
      if (b !== undefined) explicitOpeningBalance = b;
    } else if (/^saldo\b|saldo\s*(atual|final|do\s*dia|dispon[ií]vel)/i.test(joined)) {
      const b = resolveBalanceRowAmount(metaCols, mapping, hints.signIndicatorCol);
      if (b !== undefined) explicitEndingBalance = b;
    }
  }

  const rows: ParseResultPayload['rows'] = [];
  const rowBalances: Array<{ date: string; idx: number; bal: number; amt: number }> = [];
  const trailingMetaLines: string[] = [];
  let minDate: string | undefined;
  let maxDate: string | undefined;

  for (let i = startRow; i < allLines.length; i++) {
    const line = allLines[i];
    const cols = splitCsvLine(line, delimiter);
    if (cols.length < 2) continue;

    const rawDate = cols[mapping.dateCol];
    const parsedDate = parseFlexibleDate(rawDate);
    const joined = cols.join(' ');
    const isBalanceRowByText =
      /\b(?:saldo\s*(?:anterior|inicial|do\s*dia|final|atual|total|dispon[ií]vel)|s\s+a\s+l\s+d\s+o)\b/i.test(
        joined
      );

    if (!parsedDate || isBalanceRowByText) {
      if (/saldo\s*(anterior|inicial)/i.test(joined)) {
        const b = resolveBalanceRowAmount(cols, mapping, hints.signIndicatorCol);
        if (b !== undefined) explicitOpeningBalance = b;
        continue;
      }
      if (/saldo\s*(final|atual|total|do\s*dia|dispon[ií]vel)|s\s+a\s+l\s+d\s+o/i.test(joined)) {
        const b = resolveBalanceRowAmount(cols, mapping, hints.signIndicatorCol);
        if (b !== undefined) explicitEndingBalance = b;
        continue;
      }
      if (!parsedDate) {
        // Safe trailing metadata (e.g. footer "Agência;1234-5;Conta;98765-4")
        if (
          /(?:ag[eê]ncia|conta|prefixo|titular|cliente|raz[aã]o\s*social|cpf|cnpj)/i.test(joined) &&
          !/\b(?:pix|ted|doc|compra|pagamento|transferencia|resgate|aplicacao)\b/i.test(joined)
        ) {
          trailingMetaLines.push(line);
        }
        continue;
      }
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

    const descParts: string[] = [];
    if (primaryDesc) descParts.push(primaryDesc);
    if (
      secondaryDesc &&
      secondaryDesc.toLowerCase() !== primaryDesc.toLowerCase() &&
      !primaryDesc.toLowerCase().includes(secondaryDesc.toLowerCase())
    ) {
      descParts.push(secondaryDesc);
    }

    const desc = sanitizeExtractedText(descParts.join(' - ') || 'Movimento Banco do Brasil', 220);

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
        : hints.signIndicatorCol !== undefined
          ? sanitizeExtractedText(cols[hints.signIndicatorCol] || '', 40) || undefined
          : undefined;

    const rawIdCell = mapping.idCol !== undefined ? cols[mapping.idCol] : undefined;
    const normalizedDocId = normalizeTransactionIdToken(rawIdCell);
    const structuredDescId = !normalizedDocId
      ? extractBancoDoBrasilStructuredId(`${primaryDesc} ${secondaryDesc}`)
      : undefined;
    const resolvedTxId = normalizedDocId || structuredDescId;

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
      bankTransactionId: resolvedTxId,
      counterparty:
        mapping.counterpartyCol !== undefined
          ? sanitizeExtractedText(cols[mapping.counterpartyCol] || '', 120) || undefined
          : undefined,
      rawOperationHint,
      rawRowSnapshot: sanitizeRawRowSnapshot(rawObj),
      confidence: 0.95,
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

  if (rows.length === 0) {
    warnings.push(
      'Nenhuma linha financeira válida foi extraída do CSV do Banco do Brasil. Ajuste o mapeamento de colunas abaixo.'
    );
  }

  const sampleRows = allLines
    .slice(startRow, startRow + 6)
    .map((l) => splitCsvLine(l, delimiter));

  const headerMetadataText = [
    ...leadingMetaLines,
    ...trailingMetaLines,
    headers.join(delimiter),
  ].join('\n');

  const holderMeta = extractStatementHolderMetadata({
    headerText: headerMetadataText,
    bankCode: '001',
    institutionId: 'inst-bb',
  });

  if (holderMeta.hasConflictingTaxDocuments && holderMeta.conflictReason) {
    warnings.push(holderMeta.conflictReason);
  }

  return {
    format: 'CSV',
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName: 'Banco do Brasil',
      bankCode: '001',
      bankIspb: '00000000',
      bankType: 'fisico',
      detectionConfidence: 'alta',
      institutionId: 'inst-bb',
      institutionCategory: 'BANCO_FISICO',
      detectedStatementProfile: 'bb_csv',
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
        'Confirme a titularidade CPF/CNPJ e conta do extrato CSV do Banco do Brasil.',
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
