import type { EntityId } from '../../types';
import {
  detectTaxDocumentNature,
  digitsOnly,
  maskAccountNumber,
  sanitizeExtractedText,
} from './fileSecurity';

export type NubankProfileId = 'nubank_pf' | 'nubank_pj';

export type StatementProfileId =
  | 'rico_csv'
  | 'nubank_csv'
  | 'inter_csv'
  | 'bb_csv'
  | 'bb_xlsx'
  | '99pay_xlsx'
  | 'ofx_padrao'
  | 'pdf_bancario'
  | 'generico';

export interface NubankAccountProfileMeta {
  profileId: NubankProfileId;
  institutionId: 'inst-nubank';
  compeCode: '260';
  ispb: '18236120';
  label: string;
  shortLabel: string;
  accountTypeLabel: string;
  entityId: EntityId;
  aliases: string[];
}

export const NUBANK_ACCOUNT_PROFILES: Record<NubankProfileId, NubankAccountProfileMeta> = {
  nubank_pf: {
    profileId: 'nubank_pf',
    institutionId: 'inst-nubank',
    compeCode: '260',
    ispb: '18236120',
    label: 'Nubank Pessoa Física',
    shortLabel: 'Pessoa Física',
    accountTypeLabel: 'Conta Pessoal',
    entityId: 'CPF',
    aliases: [
      'nubank pf',
      'nubank pessoa fisica',
      'nuconta',
      'conta pessoal nubank',
      'nu pagamentos pf',
    ],
  },
  nubank_pj: {
    profileId: 'nubank_pj',
    institutionId: 'inst-nubank',
    compeCode: '260',
    ispb: '18236120',
    label: 'Nubank Empresas / Pessoa Jurídica',
    shortLabel: 'Pessoa Jurídica',
    accountTypeLabel: 'Conta Empresarial',
    entityId: 'CNPJ',
    aliases: [
      'nubank empresas',
      'nu empresas',
      'nubank pj',
      'nubank pessoa juridica',
      'conta pj nubank',
      'conta empresarial nubank',
    ],
  },
};

export interface StatementProfileDetection {
  profileId: StatementProfileId;
  profileLabel: string;
  inferredBankCode?: string;
  inferredBankName?: string;
  inferredBankIspb?: string;
  inferredBankType?: 'fisico' | 'digital';
  inferredInstitutionId?: string;
}

function normText(v: string): string {
  return (v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectStatementProfile(params: {
  format: 'CSV' | 'XLSX' | 'XLS' | 'OFX' | 'PDF' | 'XML' | 'JSON' | 'IMAGE';
  headers?: string[];
  headerLines?: string[];
  delimiter?: string;
  rawTextSample?: string;
  sampleRows?: string[][];
  fileName?: string;
}): StatementProfileDetection {
  const {
    format,
    headers = [],
    headerLines = [],
    delimiter,
    rawTextSample = '',
    sampleRows = [],
    fileName = '',
  } = params;

  const normHeaders = headers.map(normText);
  const joinedHeaders = normHeaders.join(' | ');
  const normMeta = normText(`${headerLines.join('\n')} ${rawTextSample}`);
  const normFile = normText(fileName);
  const combinedHint = `${normMeta} ${normFile}`;

  const hasUuidInSample = sampleRows.some((row) =>
    row.some((cell) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(cell || '').trim()
      )
    )
  );

  if (format === 'CSV') {
    const hasInterCols =
      normHeaders.some((h) => /data\s*lanc/.test(h)) &&
      normHeaders.some((h) => /histor/.test(h)) &&
      normHeaders.some((h) => /desc/.test(h)) &&
      normHeaders.some((h) => /valor/.test(h));
    const hasInterMeta =
      /banco\s*inter|inter\s*s\.?a|intermedium|inter&co|conta\s*inter|\b00416968\b/.test(
        combinedHint
      ) ||
      (delimiter === ';' &&
        /conta\s*[:;]/i.test(headerLines.join('\n')) &&
        /saldo\s*[:;]/i.test(headerLines.join('\n')) &&
        hasInterCols);

    if (hasInterCols || hasInterMeta) {
      return {
        profileId: 'inter_csv',
        profileLabel: 'Banco Inter — CSV',
        inferredBankCode: '077',
        inferredBankName: 'Banco Inter',
        inferredBankIspb: '00416968',
        inferredBankType: 'digital',
        inferredInstitutionId: 'inst-inter',
      };
    }

    const hasNubankCols =
      (normHeaders.some((h) => /^data$|^date$/.test(h)) &&
        normHeaders.some((h) => /^valor$|^amount$/.test(h)) &&
        normHeaders.some((h) => /identificador/.test(h)) &&
        normHeaders.some((h) => /desc/.test(h))) ||
      (normHeaders.some((h) => /^date$/.test(h)) &&
        normHeaders.some((h) => /^title$/.test(h)) &&
        normHeaders.some((h) => /^amount$/.test(h)));

    const hasNubankHint =
      /nubank|nu\s*pagamentos|nuconta|nu\s*empresas|\b260\b|\b18236120\b/.test(combinedHint) ||
      /^nu[_-]/.test(normFile);

    if ((hasNubankCols && (hasUuidInSample || hasNubankHint)) || (hasNubankHint && format === 'CSV')) {
      return {
        profileId: 'nubank_csv',
        profileLabel: 'Nubank — CSV',
        inferredBankCode: '260',
        inferredBankName: 'Nubank',
        inferredBankIspb: '18236120',
        inferredBankType: 'digital',
        inferredInstitutionId: 'inst-nubank',
      };
    }

    const hasRicoHint =
      /\brico\b|rico\s*investimentos|rico\s*corretora|cartao\s*rico/.test(combinedHint);
    const hasRicoCols =
      normHeaders.some((h) => /data/.test(h)) &&
      normHeaders.some((h) => /histor|desc|ativo/.test(h)) &&
      normHeaders.some((h) => /valor|debito|credito/.test(h)) &&
      (normHeaders.some((h) => /saldo/.test(h)) || normHeaders.some((h) => /protocolo|ativo/.test(h)));

    if (hasRicoHint || (hasRicoCols && /\b102\b|\b02332886\b/.test(combinedHint))) {
      return {
        profileId: 'rico_csv',
        profileLabel: 'Rico Investimentos — CSV',
        inferredBankCode: '102',
        inferredBankName: 'Rico Investimentos',
        inferredBankIspb: '02332886',
        inferredBankType: 'digital',
        inferredInstitutionId: 'inst-rico',
      };
    }
    const hasBbOfficialCols =
      normHeaders.some((h) => /^data$/.test(h)) &&
      normHeaders.some((h) => /^lancamento$/.test(h)) &&
      normHeaders.some((h) => /^detalhes?$/.test(h)) &&
      normHeaders.some((h) => /n[ºo°.]*\s*documento|numero\s*(?:do\s*)?documento|^documento$/.test(h)) &&
      normHeaders.some((h) => /^valor$/.test(h)) &&
      normHeaders.some((h) => /tipo\s*(?:de\s*)?lancamento|^d\/c$/.test(h));

    const hasBbLegacyCols =
      (normHeaders.some((h) => /dependencia\s*origem/.test(h)) ||
        normHeaders.some((h) => /data\s*balancete/.test(h)) ||
        normHeaders.some((h) => /numero\s*do\s*documento|n[ºo°.]*\s*documento/.test(h))) &&
      normHeaders.some((h) => /historico|lancamento|detalhe|desc/.test(h)) &&
      normHeaders.some((h) => /valor/.test(h));

    const hasBbHint =
      /banco\s*do\s*brasil|\bbb\s*s\.?a\b|\bbco\s*(?:do\s*)?brasil\b|\bgerenciador\s*financeiro\b|\b00000000\b/.test(
        combinedHint
      ) ||
      /(?:^|[\s_-])bb(?:[\s_-]|$)/.test(normFile);

    if (hasBbOfficialCols || hasBbLegacyCols || (hasBbHint && normHeaders.some((h) => /valor/.test(h)))) {
      return {
        profileId: 'bb_csv',
        profileLabel: 'Banco do Brasil — CSV',
        inferredBankCode: '001',
        inferredBankName: 'Banco do Brasil',
        inferredBankIspb: '00000000',
        inferredBankType: 'fisico',
        inferredInstitutionId: 'inst-bb',
      };
    }
  }

  if (format === 'XLSX' || format === 'XLS') {
    const has99PayHint = /99pay|99\s*pay|99\s*tecnologia|\b05684234\b/.test(combinedHint);
    const has99PayCols =
      normHeaders.some((h) => /data\s*e\s*hora|data\s*da\s*transac/.test(h)) &&
      normHeaders.some((h) => /tipo\s*de\s*transac/.test(h)) &&
      (normHeaders.some((h) => /saldo\s*apos/.test(h)) ||
        normHeaders.some((h) => /id\s*da\s*transac/.test(h)));

    if (has99PayHint || has99PayCols) {
      return {
        profileId: '99pay_xlsx',
        profileLabel: '99Pay — XLSX',
        inferredBankCode: '301',
        inferredBankName: '99Pay',
        inferredBankIspb: '05684234',
        inferredBankType: 'digital',
        inferredInstitutionId: 'inst-99pay',
      };
    }

    const hasBbOfficialCols =
      normHeaders.some((h) => /^data$/.test(h)) &&
      normHeaders.some((h) => /^lancamento$/.test(h)) &&
      normHeaders.some((h) => /^detalhes?$/.test(h)) &&
      normHeaders.some((h) => /n[ºo°.]*\s*documento|numero\s*(?:do\s*)?documento|^documento$/.test(h)) &&
      normHeaders.some((h) => /^valor$/.test(h)) &&
      normHeaders.some((h) => /tipo\s*(?:de\s*)?lancamento|^d\/c$/.test(h));

    const hasBbHint =
      /banco\s*do\s*brasil|\bbb\s*s\.?a\b|\bbco\s*(?:do\s*)?brasil\b|\bgerenciador\s*financeiro\b|\b00000000\b/.test(
        combinedHint
      ) || /(?:^|[\s_-])bb(?:[\s_-]|$)/.test(normFile);
    const hasBbCols =
      hasBbOfficialCols ||
      ((normHeaders.some((h) => /dependencia\s*origem/.test(h)) ||
        normHeaders.some((h) => /data\s*balancete/.test(h)) ||
        normHeaders.some((h) => /numero\s*do\s*documento|n[ºo°.]*\s*documento/.test(h))) &&
        normHeaders.some((h) => /historico|lancamento|detalhe|desc/.test(h)) &&
        normHeaders.some((h) => /valor/.test(h)));

    if (hasBbHint || hasBbCols || /s\s+a\s+l\s+d\s+o/i.test(rawTextSample)) {
      return {
        profileId: 'bb_xlsx',
        profileLabel: 'Banco do Brasil — XLSX',
        inferredBankCode: '001',
        inferredBankName: 'Banco do Brasil',
        inferredBankIspb: '00000000',
        inferredBankType: 'fisico',
        inferredInstitutionId: 'inst-bb',
      };
    }
  }

  if (format === 'OFX') {
    return { profileId: 'ofx_padrao', profileLabel: 'OFX Padrão Bancário' };
  }
  if (format === 'PDF') {
    return { profileId: 'pdf_bancario', profileLabel: 'PDF Bancário' };
  }

  void joinedHeaders;
  return { profileId: 'generico', profileLabel: `Extrato ${format}` };
}

export interface ExtractedHolderMetadata {
  maskedDocument?: string;
  documentValid?: boolean;
  holderNature?: EntityId;
  hasConflictingTaxDocuments?: boolean;
  conflictReason?: string;
  agency?: string;
  rawAccountNumber?: string;
  rawAccountNumberDigits?: string;
  maskedAccountNumber?: string;
  holderName?: string;
  companyName?: string;
  accountType?: string;
  accountProfileId?: NubankProfileId;
  accountProfileLabel?: string;
}

export function extractStatementHolderMetadata(params: {
  headerText: string;
  bankCode?: string;
  institutionId?: string;
  ofxBranchId?: string;
  ofxAcctId?: string;
  ofxAcctType?: string;
  ofxOrg?: string;
}): ExtractedHolderMetadata {
  const {
    headerText,
    bankCode,
    institutionId,
    ofxBranchId,
    ofxAcctId,
    ofxAcctType,
    ofxOrg,
  } = params;

  const metaScope = [headerText, ofxOrg, ofxAcctId].filter(Boolean).join('\n');

  // Collect all valid CPFs and CNPJs strictly inside statement metadata/header (never transaction rows)
  const docCandidates =
    metaScope.match(
      /\b(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/g
    ) || [];

  const validCpfs = new Map<string, ReturnType<typeof detectTaxDocumentNature>>();
  const validCnpjs = new Map<string, ReturnType<typeof detectTaxDocumentNature>>();
  let fallbackInvalidDoc: ReturnType<typeof detectTaxDocumentNature> | undefined;

  for (const cand of docCandidates) {
    // Ignore obvious date patterns like 20261101120000 or pure timestamps
    const digits = digitsOnly(cand);
    if (/^(?:19|20)\d{6}(?:0\d|1\d|2[0-3])\d{4}$/.test(digits)) continue;
    const info = detectTaxDocumentNature(cand);
    if (info.valid && info.nature === 'CPF' && info.normalizedDigits) {
      validCpfs.set(info.normalizedDigits, info);
    } else if (info.valid && info.nature === 'CNPJ' && info.normalizedDigits) {
      validCnpjs.set(info.normalizedDigits, info);
    } else if (!fallbackInvalidDoc && /[./-]/.test(cand) && info.nature) {
      fallbackInvalidDoc = info;
    }
  }

  // Also detect masked CPF/CNPJ cues when full digits are masked in PDF/CSV exports (e.g. ***.123.456-**)
  const hasMaskedCpf = /\*{3}\.\d{3}\.\d{3}-\*{2}/.test(metaScope);
  const hasMaskedCnpj = /\*{2}\.\d{3}\.\d{3}\/\d{4}-\*{2}/.test(metaScope);

  const normHeader = normText(metaScope);
  const hasExplicitPjCue =
    /\b(?:nubank\s+empresas|nu\s+empresas|nubank\s+pj|nubank\s+pessoa\s+juridica|bb\s+empresas|bb\s+empresarial|gerenciador\s+financeiro|autoatendimento\s+pj|conta\s+empresarial|conta\s+pj|pessoa\s+juridica|razao\s+social|nome\s+empresarial)\b/.test(
      normHeader
    ) || /\bcnpj\s*[:#-]?\s*(?:\d|\*)/.test(normHeader);

  const hasExplicitPfCue =
    /\b(?:nubank\s+pf|nubank\s+pessoa\s+fisica|bb\s+estilo|bb\s+exclusive|conta\s+pessoal|pessoa\s+fisica|nuconta(?:\s+pf)?)\b/.test(
      normHeader
    ) || /\bcpf\s*[:#-]?\s*(?:\d|\*)/.test(normHeader);

  let hasConflictingTaxDocuments = false;
  let conflictReason: string | undefined;
  let holderNature: EntityId | undefined;
  let documentValid: boolean | undefined;
  let maskedDocument: string | undefined;

  if (validCpfs.size > 0 && validCnpjs.size > 0) {
    hasConflictingTaxDocuments = true;
    conflictReason =
      'Conflito de titularidade: o cabeçalho do extrato contém CPF e CNPJ válidos divergentes. Confirme manualmente a conta correta.';
  } else if (validCpfs.size > 1 || validCnpjs.size > 1) {
    hasConflictingTaxDocuments = true;
    conflictReason =
      'Múltiplos documentos fiscais diferentes identificados no cabeçalho do extrato. Confirme manualmente a conta.';
  } else if (validCnpjs.size === 1) {
    const cnpj = Array.from(validCnpjs.values())[0];
    if (hasExplicitPfCue && !hasExplicitPjCue) {
      hasConflictingTaxDocuments = true;
      conflictReason =
        'Divergência detectada: cabeçalho indica Pessoa Física (PF), porém o documento validado é um CNPJ.';
    } else {
      holderNature = 'CNPJ';
      documentValid = true;
      maskedDocument = cnpj.masked;
    }
  } else if (validCpfs.size === 1) {
    const cpf = Array.from(validCpfs.values())[0];
    if (hasExplicitPjCue && !hasExplicitPfCue) {
      hasConflictingTaxDocuments = true;
      conflictReason =
        'Divergência detectada: cabeçalho indica Pessoa Jurídica (PJ/Empresas), porém o documento validado é um CPF.';
    } else {
      holderNature = 'CPF';
      documentValid = true;
      maskedDocument = cpf.masked;
    }
  } else if (hasExplicitPjCue && !hasExplicitPfCue) {
    holderNature = 'CNPJ';
    documentValid = hasMaskedCnpj ? true : fallbackInvalidDoc?.valid ?? true;
    maskedDocument =
      metaScope.match(/\*{2}\.\d{3}\.\d{3}\/\d{4}-\*{2}/)?.[0] || fallbackInvalidDoc?.masked;
  } else if (hasExplicitPfCue && !hasExplicitPjCue) {
    holderNature = 'CPF';
    documentValid = hasMaskedCpf ? true : fallbackInvalidDoc?.valid ?? true;
    maskedDocument =
      metaScope.match(/\*{3}\.\d{3}\.\d{3}-\*{2}/)?.[0] || fallbackInvalidDoc?.masked;
  } else if (hasExplicitPjCue && hasExplicitPfCue) {
    hasConflictingTaxDocuments = true;
    conflictReason =
      'Cabeçalho apresenta referências simultâneas a PF e PJ sem definição única. Confirme manualmente.';
  } else if (fallbackInvalidDoc) {
    maskedDocument = fallbackInvalidDoc.masked;
    documentValid = false;
  }

  // Extract combined "Ag/Conta: 1234-5 / 67890-1" if present in BB or physical bank headers
  const combinedAgContaMatch = headerText.match(
    /(?:ag(?:[eê]ncia)?\s*\/\s*conta(?:\s*corrente)?)\s*[:#-]?\s*(\d{3,5}(?:-[0-9xX])?)\s*[\/|\s-]+\s*([0-9][0-9.\-xX]{2,18})/i
  );

  // Extract agency ONLY when explicitly confirmed in OFX <BRANCHID> or header text
  const headerAgencyMatch = headerText.match(
    /(?:ag[eê]ncia(?:\s*prefixo)?|depend[eê]ncia(?:\s*origem)?|prefixo|ag\.?)\s*[:#-]?\s*(\d{3,5}(?:-[0-9xX])?)/i
  );
  const confirmedAgency =
    sanitizeExtractedText(
      ofxBranchId || combinedAgContaMatch?.[1] || headerAgencyMatch?.[1] || '',
      20
    ) || undefined;

  // Extract account number from OFX <ACCTID> or header metadata (not dates/CPFs)
  const headerAccountMatch = headerText.match(
    /(?:conta(?:\s*(?:corrente|poupan[cç]a|pagamento|digital|empresarial|pessoal|pj|pf))?|c\/c|n[ºo°.]?\s*da\s*conta)\s*[:#-]?\s*([0-9][0-9.\-xX]{2,18})/i
  );
  const rawAccountNumber =
    sanitizeExtractedText(
      ofxAcctId || combinedAgContaMatch?.[2] || headerAccountMatch?.[1] || '',
      32
    ) || undefined;
  const rawAccountNumberDigits = rawAccountNumber ? digitsOnly(rawAccountNumber) || undefined : undefined;
  const maskedAccountNumber = rawAccountNumber ? maskAccountNumber(rawAccountNumber) : undefined;

  // Extract company name (Razão Social) and holder name
  const companyMatch = headerText.match(
    /(?:raz[aã]o\s*social|nome\s*empresarial|empresa)\s*[:#-]\s*([^\r\n;,|]{3,80})/i
  );
  const holderMatch = headerText.match(
    /(?:titular|correntista|cliente|favorecido)\s*[:#-]\s*([^\r\n;,|]{3,80})/i
  );

  const companyName = companyMatch?.[1]
    ? sanitizeExtractedText(companyMatch[1], 90)
    : undefined;
  const holderName = holderMatch?.[1]
    ? sanitizeExtractedText(holderMatch[1], 90)
    : undefined;

  const isNubank = bankCode === '260' || institutionId === 'inst-nubank';
  let accountProfileId: NubankProfileId | undefined;
  let accountProfileLabel: string | undefined;
  let accountType = ofxAcctType;

  if (isNubank && !hasConflictingTaxDocuments) {
    if (holderNature === 'CNPJ') {
      accountProfileId = 'nubank_pj';
      accountProfileLabel = NUBANK_ACCOUNT_PROFILES.nubank_pj.label;
      accountType = NUBANK_ACCOUNT_PROFILES.nubank_pj.accountTypeLabel;
    } else if (holderNature === 'CPF') {
      accountProfileId = 'nubank_pf';
      accountProfileLabel = NUBANK_ACCOUNT_PROFILES.nubank_pf.label;
      accountType = NUBANK_ACCOUNT_PROFILES.nubank_pf.accountTypeLabel;
    }
  } else if (holderNature === 'CNPJ' && !accountType) {
    accountType = 'Conta Empresarial';
  } else if (holderNature === 'CPF' && !accountType) {
    accountType = 'Conta Pessoal';
  }

  return {
    maskedDocument,
    documentValid,
    holderNature,
    hasConflictingTaxDocuments,
    conflictReason,
    agency: confirmedAgency,
    rawAccountNumber,
    rawAccountNumberDigits,
    maskedAccountNumber,
    holderName,
    companyName,
    accountType,
    accountProfileId,
    accountProfileLabel,
  };
}
