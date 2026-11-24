import { toCents } from '../../money/money';
import type { MoneyCents } from '../../money/money';
import type { ParseResultPayload } from '../../../types-sub/extractions';
import {
  sanitizeExtractedText,
  sanitizeRawRowSnapshot,
} from '../fileSecurity';
import { detectBankFromStatement } from '../banksRepository';
import {
  detectStatementProfile,
  extractStatementHolderMetadata,
} from '../bankStatementProfiles';
import { isBancoDoBrasilOfx, parseBancoDoBrasilOfx } from './bancoDoBrasilParser';
import { normalizeTransactionIdToken } from './tabularPrimitives';

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

function extractTag(block: string, tag: string): string | undefined {
  const xmlRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const xmlMatch = block.match(xmlRegex);
  if (xmlMatch?.[1]?.trim()) {
    return sanitizeExtractedText(decodeEntities(xmlMatch[1]), 240);
  }
  const sgmlRegex = new RegExp(`<${tag}>([^\\r\\n<]+)`, 'i');
  const sgmlMatch = block.match(sgmlRegex);
  if (sgmlMatch?.[1]?.trim()) {
    return sanitizeExtractedText(decodeEntities(sgmlMatch[1]), 240);
  }
  return undefined;
}

function parseOfxDate(raw?: string): string | undefined {
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

function parseOfxAmount(raw?: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/\s+/g, '');
  const normalized =
    cleaned.includes(',') && cleaned.includes('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : undefined;
}

export function decodeTextBuffer(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buffer);
    } catch {
      return new TextDecoder('latin1').decode(buffer);
    }
  }
}

export function parseOfxStatement(rawContent: string, fileName = ''): ParseResultPayload {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!rawContent || !rawContent.trim()) {
    return {
      format: 'OFX',
      parseSource: 'LOCAL',
      identifiedAccount: { requiresConfirmation: true, confirmationReason: 'Arquivo OFX vazio.' },
      warnings,
      errors: ['Arquivo OFX vazio ou ilegível.'],
      requiresManualReview: true,
      rows: [],
    };
  }

  if (isBancoDoBrasilOfx(rawContent, fileName)) {
    return parseBancoDoBrasilOfx(rawContent, fileName);
  }

  const hasOfxHeader = /<OFX>|<STMTTRN>|OFXHEADER/i.test(rawContent);
  if (!hasOfxHeader) {
    errors.push('Estrutura OFX inválida: cabeçalho ou blocos <STMTTRN> ausentes.');
  }

  const tranListIdx = rawContent.search(/<BANKTRANLIST>/i);
  const ofxHeaderBlock =
    tranListIdx > 0 ? rawContent.slice(0, tranListIdx) : rawContent.slice(0, 6000);
  const acctFromBlock =
    rawContent.match(
      /<(?:BANKACCTFROM|CCACCTFROM)>[\s\S]*?(?:<\/(?:BANKACCTFROM|CCACCTFROM)>|<BANKTRANLIST>|$)/i
    )?.[0] || '';
  const combinedHeaderScope = [ofxHeaderBlock, acctFromBlock].filter(Boolean).join('\n');

  const bankId =
    extractTag(combinedHeaderScope, 'BANKID') || extractTag(combinedHeaderScope, 'FID');
  const org = extractTag(combinedHeaderScope, 'ORG');
  const acctId = extractTag(acctFromBlock || combinedHeaderScope, 'ACCTID');
  const acctType = extractTag(acctFromBlock || combinedHeaderScope, 'ACCTTYPE');
  const branchId = extractTag(acctFromBlock || combinedHeaderScope, 'BRANCHID');
  const acctHolderName =
    extractTag(combinedHeaderScope, 'ACCTNAME') || extractTag(combinedHeaderScope, 'NAME');
  const currency = (extractTag(combinedHeaderScope, 'CURDEF') || 'BRL').toUpperCase();
  const dtStart = parseOfxDate(extractTag(rawContent, 'DTSTART'));
  const dtEnd = parseOfxDate(extractTag(rawContent, 'DTEND'));

  // Ledger / Available balances
  const ledgerBlock =
    rawContent.match(/<LEDGERBAL>[\s\S]*?(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i)?.[0] ||
    '';
  const availBlock =
    rawContent.match(/<AVAILBAL>[\s\S]*?(?:<\/AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i)?.[0] || '';
  const ledgerAmt = parseOfxAmount(extractTag(ledgerBlock, 'BALAMT'));
  const availAmt = parseOfxAmount(extractTag(availBlock, 'BALAMT'));

  if (ledgerAmt === undefined) {
    warnings.push(
      'O arquivo OFX não informou saldo final (<LEDGERBAL>). Conciliação de saldo ficará pendente de saldo inicial/final manual.'
    );
  }
  if (!acctId) {
    warnings.push(
      'Identificador da conta (<ACCTID>) não encontrado no OFX. Selecione ou confirme a conta manualmente.'
    );
  }

  const rawBlocks = rawContent.split(/<STMTTRN>/i).slice(1);
  if (rawBlocks.length === 0) {
    warnings.push('Nenhuma movimentação (<STMTTRN>) encontrada neste arquivo OFX.');
  }

  const rows: ParseResultPayload['rows'] = [];
  let missingFitIdCount = 0;

  rawBlocks.forEach((rawBlock, idx) => {
    const endIdx = rawBlock.search(/<\/STMTTRN>/i);
    const block = endIdx >= 0 ? rawBlock.slice(0, endIdx) : rawBlock;

    const dtPosted = parseOfxDate(extractTag(block, 'DTPOSTED'));
    const dtUser = parseOfxDate(extractTag(block, 'DTUSER'));
    const amtNum = parseOfxAmount(extractTag(block, 'TRNAMT'));
    const trnType = extractTag(block, 'TRNTYPE');
    const fitId = normalizeTransactionIdToken(extractTag(block, 'FITID'));
    const checkNum = normalizeTransactionIdToken(
      extractTag(block, 'CHECKNUM') || extractTag(block, 'REFNUM')
    );
    const memo = extractTag(block, 'MEMO');
    const name = extractTag(block, 'NAME');

    if (amtNum === undefined || amtNum === 0) {
      warnings.push(`Bloco OFX #${idx + 1} ignorado por valor ausente ou zerado.`);
      return;
    }

    if (!dtPosted && !dtUser) {
      warnings.push(
        `Movimentação "${memo || name || `#${idx + 1}`}" sem data válida no OFX; revisão necessária.`
      );
    }
    if (!fitId) {
      missingFitIdCount += 1;
    }

    const combinedDesc =
      [name, memo]
        .filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i)
        .join(' · ') || 'Movimento OFX';

    const signedCents = (Math.round(amtNum * 100) as MoneyCents) || toCents(amtNum);

    rows.push({
      date: dtUser || dtPosted || dtEnd || dtStart || '',
      postedDate: dtPosted,
      description: combinedDesc,
      amountSignedCents: signedCents,
      currency,
      bankTransactionId: fitId || checkNum,
      rawOperationHint: trnType,
      rawRowSnapshot: sanitizeRawRowSnapshot({
        TRNTYPE: trnType || '',
        DTPOSTED: dtPosted || '',
        TRNAMT: amtNum,
        FITID: fitId || '',
        CHECKNUM: checkNum || '',
        NAME: name || '',
        MEMO: memo || '',
      }),
      confidence: dtPosted && fitId ? 0.96 : 0.78,
      doubtReason: !dtPosted
        ? 'Data da operação ausente no arquivo OFX.'
        : !fitId
          ? 'Sem FITID bancário original; conferência recomendada.'
          : undefined,
    });
  });

  if (missingFitIdCount > 0) {
    warnings.push(`${missingFitIdCount} lançamento(s) OFX sem identificador FITID nativo.`);
  }

  const reportedEndingBalanceCents =
    ledgerAmt !== undefined ? (Math.round(ledgerAmt * 100) as MoneyCents) : undefined;
  const availableBalanceCents =
    availAmt !== undefined ? (Math.round(availAmt * 100) as MoneyCents) : undefined;

  const detectedBank = detectBankFromStatement(rawContent, fileName);
  const profileDetection = detectStatementProfile({
    format: 'OFX',
    rawTextSample: combinedHeaderScope,
    fileName,
  });
  const holderMeta = extractStatementHolderMetadata({
    headerText: combinedHeaderScope,
    bankCode: bankId || detectedBank.code,
    institutionId: detectedBank.institutionId,
    ofxBranchId: branchId,
    ofxAcctId: acctId,
    ofxAcctType: acctType,
    ofxOrg: org,
  });

  if (holderMeta.hasConflictingTaxDocuments && holderMeta.conflictReason) {
    warnings.push(holderMeta.conflictReason);
  }

  return {
    format: 'OFX',
    parseSource: 'LOCAL',
    identifiedAccount: {
      bankName:
        detectedBank.type !== 'desconhecido' && detectedBank.name
          ? detectedBank.name
          : org || (fileName ? fileName.replace(/\.ofx$/i, '') : undefined),
      bankCode: bankId || detectedBank.code,
      bankIspb: detectedBank.ispb,
      bankType: detectedBank.type,
      detectionConfidence: detectedBank.confidence,
      institutionId: detectedBank.institutionId,
      institutionCategory:
        detectedBank.type === 'fisico'
          ? 'BANCO_FISICO'
          : detectedBank.type === 'digital'
            ? 'BANCO_DIGITAL'
            : undefined,
      detectedStatementProfile: profileDetection.profileId,
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
          : 'Confirme a associação da conta identificada antes de efetivar lançamentos.'),
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
