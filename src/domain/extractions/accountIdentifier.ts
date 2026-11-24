import type { Account, CreditCard, EntityId } from '../../types';
import type {
  AccountExtensionMeta,
  IdentifiedAccountInfo,
  InstitutionProfile,
} from '../../types-sub/extractions';
import { digitsOnly, maskAccountNumber } from './fileSecurity';
import { inferCategoryFromText, resolveInstitutionMatch } from './institutionRegistry';
import { findBankByCodeOrIspb } from './banksRepository';
import { NUBANK_ACCOUNT_PROFILES } from './bankStatementProfiles';

function taxDocCoreDigits(maskedOrRaw?: string): string {
  // For masked CPF ***.982.247-** -> "982247"; for full CPF/CNPJ -> middle digits
  const raw = String(maskedOrRaw || '').trim();
  if (!raw) return '';
  if (raw.includes('*')) {
    return digitsOnly(raw);
  }
  const d = digitsOnly(raw);
  if (d.length === 11) return d.slice(3, 9);
  if (d.length === 14) return d.slice(2, 12);
  return d;
}

function normalizeCompeCodeLocal(code?: string): string {
  const digits = digitsOnly(code || '').replace(/^0+/, '');
  if (!digits) return '';
  return digits.length <= 3 ? digits.padStart(3, '0') : digits;
}

function normalizeAgencyTokens(raw?: string): { alnum: string; base4: string } {
  const cleaned = String(raw || '').trim().toLowerCase();
  const alnum = cleaned.replace(/[^0-9x]/g, '');
  const stripped = alnum.replace(/^0+(?=\d{4,5}x?$)/, '');
  const onlyDigits = digitsOnly(stripped);
  // BB agencies are 4 base digits + optional 1 check digit (-5 or -X); keep 4-digit base when 5 chars
  const base4 =
    stripped.length === 5
      ? stripped.slice(0, 4)
      : onlyDigits.length === 5
        ? onlyDigits.slice(0, 4)
        : stripped || alnum;
  return { alnum: stripped || alnum, base4 };
}

function agenciesCompatible(a?: string, b?: string): boolean {
  const tokA = normalizeAgencyTokens(a);
  const tokB = normalizeAgencyTokens(b);
  if (!tokA.alnum || !tokB.alnum) return true;
  if (tokA.alnum === tokB.alnum) return true;
  const stripA = tokA.alnum.replace(/^0+/, '');
  const stripB = tokB.alnum.replace(/^0+/, '');
  if (stripA && stripA === stripB) return true;
  // Base 4-digit match (e.g. "1234" vs "1234-5" or "1234-X" or "000012345")
  if (tokA.base4.length === 4 && tokA.base4 === tokB.base4) return true;
  return false;
}

function normalizeAccountComparable(raw?: string): {
  digits: string;
  digitsStripped: string;
  alnum: string;
  stripped: string;
  last4: string;
} {
  const cleaned = String(raw || '').trim().toLowerCase();
  const alnum = cleaned.replace(/[^0-9x]/g, '');
  const digits = digitsOnly(cleaned);
  const digitsStripped = digits.replace(/^0+/, '') || digits;
  const stripped = (alnum || digits).replace(/^0+/, '') || digits;
  const last4 = digits.slice(-4) || alnum.slice(-4);
  return { digits, digitsStripped, alnum, stripped, last4 };
}

function extractFallbackAccountNumberFromName(accountName?: string): string {
  const name = String(accountName || '');
  const explicitMatch = name.match(/(?:[•*]{2,}\s*\d{3,4}(?:-[0-9xX])?|\d{4,9}-[0-9xX])/);
  return explicitMatch?.[0] || '';
}

export function identifySourceAccount(params: {
  extracted: IdentifiedAccountInfo;
  fileName: string;
  accounts: Account[];
  creditCards: CreditCard[];
  accountExtensions: AccountExtensionMeta[];
  institutions: InstitutionProfile[];
}): IdentifiedAccountInfo {
  const { extracted, fileName, accounts, creditCards, accountExtensions, institutions } = params;

  const matchedInstitution = resolveInstitutionMatch({
    institutionId: extracted.institutionId,
    bankCode: extracted.bankCode,
    bankNameHint: extracted.bankName,
    fileNameHint: fileName,
    catalog: institutions,
  });

  const extById = new Map(accountExtensions.map((e) => [e.id, e]));
  const activeAccounts = accounts.filter((a) => !a.archived);

  const hasDocConflict =
    /conflito|diverg[eê]ncia|m[uú]ltiplos documentos/i.test(extracted.confirmationReason || '') &&
    !extracted.holderNature;

  // Strict rule: do NOT infer holderNature (CPF vs CNPJ) from institution name or filename alone.
  // Only trust verified document digits / explicit statement-content profile.
  const verifiedNature: EntityId | undefined =
    !hasDocConflict && extracted.documentValid ? extracted.holderNature : undefined;

  const isCardStatement =
    extracted.institutionCategory === 'CARTAO_CREDITO' ||
    /fatura|cartao|cart[aã]o|visa|master|elo/i.test(`${fileName} ${extracted.accountType || ''}`);

  let matchedCardId: string | undefined;
  let matchedAccountId: string | undefined;
  const candidateAccountIds: string[] = [];

  if (isCardStatement && !hasDocConflict) {
    const instNameLower = (matchedInstitution?.commercialName || extracted.bankName || '').toLowerCase();
    const last4 = digitsOnly(extracted.rawAccountNumberDigits || extracted.maskedAccountNumber || '').slice(-4);
    const matchingCards = creditCards.filter((c) => {
      const cardMatchInst = instNameLower && c.institutionName.toLowerCase().includes(instNameLower);
      const cardMatchLast4 = last4 && c.last4 === last4;
      const cardMatchNature = !verifiedNature || c.entityId === verifiedNature;
      return (cardMatchInst || cardMatchLast4) && cardMatchNature;
    });
    if (matchingCards.length === 1) {
      matchedCardId = matchingCards[0].id;
    }
  }

  const instTokens = [
    matchedInstitution?.commercialName,
    matchedInstitution?.name,
    extracted.bankName,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  const targetCompe = normalizeCompeCodeLocal(matchedInstitution?.code || extracted.bankCode);
  const SHARED_COMPE_CODES = new Set(['102', '237', '341', '084']);

  const extractedComp = normalizeAccountComparable(
    extracted.rawAccountNumberDigits ||
      (extracted.maskedAccountNumber && !extracted.maskedAccountNumber.includes('•')
        ? extracted.maskedAccountNumber
        : '')
  );
  const extractedAnyDigits = digitsOnly(
    extracted.rawAccountNumberDigits || extracted.maskedAccountNumber || ''
  );
  const accountLast4 = extractedComp.last4 || extractedAnyDigits.slice(-4);
  const extractedDocCore = taxDocCoreDigits(extracted.maskedDocument);

  const exactFullMatches: string[] = [];
  const last4Matches: string[] = [];
  const institutionOnlyMatches: string[] = [];

  if (!hasDocConflict) {
    for (const acc of activeAccounts) {
      const ext = extById.get(acc.id);

      // Reject mismatched holder nature if verified document is present
      if (verifiedNature && acc.entityId !== verifiedNature) {
        continue;
      }

      // Reject if statement has a validated document core that disagrees with stored maskedHolderDoc
      const extDocCore = taxDocCoreDigits(ext?.maskedHolderDoc);
      if (extractedDocCore && extDocCore && extractedDocCore !== extDocCore) {
        continue;
      }

      const accInstLower = acc.institutionName.toLowerCase();
      const normalizedExtInstId = ext?.institutionId?.replace(/^inst_/, 'inst-');
      const normalizedMatchedInstId = matchedInstitution?.id?.replace(/^inst_/, 'inst-');
      const accCompe = normalizeCompeCodeLocal(acc.bankCode);
      const matchesByUniqueCompe =
        Boolean(targetCompe && accCompe && targetCompe === accCompe && !SHARED_COMPE_CODES.has(targetCompe));
      const matchesByBbShortAlias =
        normalizedMatchedInstId === 'inst-bb' &&
        /\bbb\b|banco\s*do\s*brasil|ourocard/i.test(`${acc.institutionName} ${acc.accountName}`);

      const sameInstitution =
        (normalizedMatchedInstId && normalizedExtInstId === normalizedMatchedInstId) ||
        matchesByUniqueCompe ||
        matchesByBbShortAlias ||
        instTokens.some(
          (tok) => tok.length >= 3 && (accInstLower.includes(tok) || tok.includes(accInstLower))
        );

      if (!sameInstitution) continue;

      // Check agency compatibility if both sides specify an agency (allows 4-digit base vs 4+DV match, e.g. "1234" vs "1234-5")
      if (!agenciesCompatible(extracted.agency, ext?.agency)) {
        continue;
      }

      const storedAccountNum =
        ext?.maskedAccountNumber || extractFallbackAccountNumberFromName(acc.accountName);
      const extComp = normalizeAccountComparable(storedAccountNum);
      const isExtFull = Boolean(
        storedAccountNum && !storedAccountNum.includes('•') && !storedAccountNum.includes('*') && extComp.digits.length > 4
      );

      const sameFullDigits =
        Boolean(
          extractedComp.stripped.length >= 4 &&
            isExtFull &&
            (extractedComp.digits === extComp.digits ||
              extractedComp.digitsStripped === extComp.digitsStripped ||
              extractedComp.stripped === extComp.stripped)
        );
      const sameLast4 = Boolean(
        accountLast4.length === 4 && extComp.last4.length === 4 && accountLast4 === extComp.last4
      );

      if (sameFullDigits) {
        exactFullMatches.push(acc.id);
      } else if (sameLast4) {
        last4Matches.push(acc.id);
      } else {
        institutionOnlyMatches.push(acc.id);
      }
    }
  }

  let hasLast4Ambiguity = false;
  if (exactFullMatches.length === 1 && last4Matches.length === 0) {
    // Unambiguous full-digit match
    candidateAccountIds.push(exactFullMatches[0]);
    matchedAccountId = exactFullMatches[0];
  } else if (exactFullMatches.length > 1 || (exactFullMatches.length >= 1 && last4Matches.length >= 1)) {
    // Full digits matched 1+, but another account shares the last4 without full digits stored
    const combined = Array.from(new Set([...exactFullMatches, ...last4Matches]));
    if (
      exactFullMatches.length === 1 &&
      last4Matches.every((id) => {
        const ext = extById.get(id);
        const storedNum = ext?.maskedAccountNumber || extractFallbackAccountNumberFromName(activeAccounts.find((a) => a.id === id)?.accountName);
        const extComp = normalizeAccountComparable(storedNum);
        return (
          storedNum &&
          !storedNum.includes('•') &&
          extComp.digits.length > 4 &&
          extComp.stripped !== extractedComp.stripped
        );
      })
    ) {
      candidateAccountIds.push(exactFullMatches[0]);
      matchedAccountId = exactFullMatches[0];
    } else {
      hasLast4Ambiguity = combined.length > 1;
      candidateAccountIds.push(...combined);
    }
  } else if (
    last4Matches.length === 1 &&
    !(() => {
      const ext = extById.get(last4Matches[0]);
      const storedNum =
        ext?.maskedAccountNumber ||
        extractFallbackAccountNumberFromName(activeAccounts.find((a) => a.id === last4Matches[0])?.accountName);
      const extComp = normalizeAccountComparable(storedNum);
      return Boolean(
        extractedComp.stripped.length > 4 &&
          storedNum &&
          !storedNum.includes('•') &&
          extComp.digits.length > 4 &&
          extComp.stripped !== extractedComp.stripped
      );
    })()
  ) {
    candidateAccountIds.push(last4Matches[0]);
    matchedAccountId = last4Matches[0];
  } else if (last4Matches.length > 1) {
    hasLast4Ambiguity = true;
    candidateAccountIds.push(...last4Matches);
  } else if (institutionOnlyMatches.length === 1) {
    const singleId = institutionOnlyMatches[0];
    const singleStored =
      extById.get(singleId)?.maskedAccountNumber ||
      extractFallbackAccountNumberFromName(activeAccounts.find((a) => a.id === singleId)?.accountName);
    const singleExtNum = digitsOnly(singleStored);
    candidateAccountIds.push(singleId);
    if (!accountLast4 || !singleExtNum) {
      matchedAccountId = singleId;
    }
  } else {
    candidateAccountIds.push(...institutionOnlyMatches);
  }

  let confirmationReason = extracted.confirmationReason;
  if (hasDocConflict) {
    confirmationReason =
      extracted.confirmationReason ||
      'Conflito de CPF/CNPJ detectado no extrato. Confirme manualmente a titularidade e a conta de destino.';
  } else if (!matchedAccountId && !matchedCardId) {
    if (hasLast4Ambiguity) {
      confirmationReason = `Múltiplas contas nesta instituição compartilham os últimos 4 dígitos (•••• ${accountLast4}). Confirme manualmente qual conta recebeu este extrato.`;
    } else if (candidateAccountIds.length > 1) {
      confirmationReason = !verifiedNature
        ? `Arquivo sem identificação de titularidade (CPF/CNPJ). Encontradas ${candidateAccountIds.length} contas possíveis — selecione manualmente.`
        : `Encontradas ${candidateAccountIds.length} contas nesta instituição. Selecione manualmente qual conta recebeu este extrato.`;
    } else if (!verifiedNature) {
      confirmationReason =
        'Documento CPF/CNPJ ausente ou não validado no arquivo. Selecione a conta ou confirme se a titularidade é CPF ou CNPJ.';
    } else {
      confirmationReason =
        'Nenhuma conta cadastrada corresponde exatamente ao extrato. Associe a uma conta existente ou confirme um novo cadastro.';
    }
  }

  const repoMatch = findBankByCodeOrIspb(
    matchedInstitution?.code || extracted.bankCode || extracted.bankIspb
  );
  const resolvedInstitutionId =
    matchedInstitution?.id || extracted.institutionId || repoMatch?.institutionId;
  const resolvedBankCode = matchedInstitution?.code || repoMatch?.codigo || extracted.bankCode;
  const resolvedBankType =
    extracted.bankType && extracted.bankType !== 'desconhecido'
      ? extracted.bankType
      : repoMatch?.tipo ??
        (matchedInstitution?.category === 'BANCO_FISICO'
          ? 'fisico'
          : matchedInstitution?.category === 'BANCO_DIGITAL'
            ? 'digital'
            : 'desconhecido');

  const inferredCategory =
    matchedInstitution?.category ||
    extracted.institutionCategory ||
    (resolvedBankType === 'fisico'
      ? 'BANCO_FISICO'
      : resolvedBankType === 'digital'
        ? 'BANCO_DIGITAL'
        : inferCategoryFromText(`${extracted.bankName || ''} ${fileName} ${extracted.accountType || ''}`));

  // Nubank internal PF / PJ profile resolution (keeps single institution inst-nubank / COMPE 260)
  const isNubank =
    resolvedInstitutionId === 'inst-nubank' || resolvedBankCode === '260';
  let accountProfileId = extracted.accountProfileId;
  let accountProfileLabel = extracted.accountProfileLabel;
  let resolvedAccountType = extracted.accountType;

  if (isNubank && !hasDocConflict) {
    const profileNature = verifiedNature;
    if (profileNature === 'CNPJ') {
      accountProfileId = 'nubank_pj';
      accountProfileLabel = NUBANK_ACCOUNT_PROFILES.nubank_pj.label;
      resolvedAccountType = NUBANK_ACCOUNT_PROFILES.nubank_pj.accountTypeLabel;
    } else if (profileNature === 'CPF') {
      accountProfileId = 'nubank_pf';
      accountProfileLabel = NUBANK_ACCOUNT_PROFILES.nubank_pf.label;
      resolvedAccountType = NUBANK_ACCOUNT_PROFILES.nubank_pf.accountTypeLabel;
    }
  }

  return {
    ...extracted,
    institutionId: resolvedInstitutionId,
    bankName: matchedInstitution?.commercialName || repoMatch?.nome || extracted.bankName,
    bankCode: resolvedBankCode,
    bankIspb: extracted.bankIspb || repoMatch?.ispb,
    bankType: resolvedBankType,
    detectionConfidence:
      extracted.detectionConfidence ||
      (matchedInstitution || repoMatch ? 'alta' : 'baixa'),
    institutionCategory: inferredCategory,
    holderNature: verifiedNature,
    accountProfileId,
    accountProfileLabel,
    accountType: resolvedAccountType,
    rawAccountNumberDigits: extractedComp.digits || extractedAnyDigits || undefined,
    maskedAccountNumber: extracted.maskedAccountNumber
      ? maskAccountNumber(extracted.maskedAccountNumber)
      : undefined,
    matchedAccountId,
    matchedCardId,
    ambiguousCandidateAccountIds:
      candidateAccountIds.length > 1 ? candidateAccountIds : undefined,
    requiresConfirmation: true, // Always require user confirmation before creating/modifying accounts
    confirmationReason,
  };
}
