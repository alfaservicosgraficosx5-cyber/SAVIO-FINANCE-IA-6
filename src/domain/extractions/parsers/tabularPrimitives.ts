import type { CsvColumnMapping } from '../../../types-sub/extractions';

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
    if (
      Number(y) >= 1900 &&
      Number(m) >= 1 &&
      Number(m) <= 12 &&
      Number(d) >= 1 &&
      Number(d) <= 31
    ) {
      return `${y}-${m}-${d}`;
    }
  }

  const br = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (br) {
    const d = br[1].padStart(2, '0');
    const m = br[2].padStart(2, '0');
    const yRaw = br[3];
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    if (
      Number(y) >= 1900 &&
      Number(m) >= 1 &&
      Number(m) <= 12 &&
      Number(d) >= 1 &&
      Number(d) <= 31
    ) {
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

export function normalizeTransactionIdToken(raw?: string): string | undefined {
  const trimmed = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (!trimmed) return undefined;
  const compact = trimmed.replace(/\s+/g, ' ');
  // Reject banking placeholder tokens ("0", "000000", "-", "N/A", "S/N")
  if (/^(?:0+|[-_.—–]+|n\/?a|s\/?n|null|undefined|sem\s*id)$/i.test(compact)) {
    return undefined;
  }
  return compact.slice(0, 100);
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
  const postedIdx = norm.findIndex((h) =>
    /liquidac|data\s*(?:do\s*)?balancete|data\s*mov/.test(h)
  );
  const signIdx = norm.findIndex((h) =>
    /^d\/c$|^dc$|^inf\.?$|^natureza$|^tipo\s*(?:de\s*)?lancamento$/.test(h)
  );
  const opTypeIdx = norm.findIndex((h) => /tipo\s*(?:de\s*)?transac|modalidade|operac/.test(h));

  let secondaryDescCol: number | undefined;
  if (histIdx >= 0 && descIdx >= 0 && histIdx !== descIdx) {
    secondaryDescCol = descIdx;
  } else if (opTypeIdx >= 0 && descIdx >= 0 && opTypeIdx !== descIdx) {
    secondaryDescCol = descIdx;
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
    findIdx([
      /^data$/,
      /^data\s*(?:lancamento|operacao|transacao|e\s*hora)?$/,
      /data/,
      /date/,
      /dt/,
      /venc/,
    ])
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
  let amountCol = findIdx([
    /valor\s*liquido/,
    /^valor$/,
    /valor/,
    /amount/,
    /quantia/,
    /montante/,
    /total/,
    /liquido/,
  ]);
  if (amountCol < 0 && headers.length > 2) amountCol = headers.length - 1;

  const counterpartyColIdx = findIdx([
    /favorec/,
    /pagador/,
    /destin/,
    /origem/,
    /contra/,
    /merchant/,
  ]);
  const balanceColIdx = findIdx([/saldo\s*apos/, /^saldo/, /saldo/, /balance/]);
  const idColIdx = findIdx([
    /fitid/,
    /^id(?:\s*(?:da\s*)?transac[aã]o)?$/,
    /numero\s*(?:do\s*)?documento/,
    /n[ºo°?.\s]*doc(?:umento)?/,
    /nr\.?\s*doc(?:umento)?/,
    /num\.?\s*doc(?:umento)?/,
    /^documento$/,
    /^doc\.?$/,
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
