import type { CategoryRule, Direction } from '../../types';
import { normalizeDescription } from '../../utils/financeCalculations';

interface BuiltinRule {
  keywords: string[];
  category: string;
  direction?: Direction;
}

const BUILTIN_RULES: BuiltinRule[] = [
  {
    keywords: ['mesma titularidade', 'entre contas proprias', 'transferencia propria'],
    category: 'Transferência',
  },
  {
    keywords: ['salario', 'folha', 'remuneracao', 'pro-labore', 'prolabore', 'adiantamento salarial'],
    category: 'Salário',
    direction: 'INCOME',
  },
  {
    keywords: ['boticario', 'o boticario', 'comissao boticario', 'repasse boticario', 'grupo boticario'],
    category: 'Vendas / Comissões',
    direction: 'INCOME',
  },
  {
    keywords: ['recargapay', 'recarga pay'],
    category: 'Investimento',
    direction: 'INCOME',
  },
  {
    keywords: ['nubank rendimento', 'rendimento nuconta', 'caixinha nubank', 'bonus nubank'],
    category: 'Investimento',
    direction: 'INCOME',
  },
  {
    keywords: ['nota fiscal', 'nfse', 'servico mei', 'recebimento cliente', 'venda cliente', 'mei'],
    category: 'Serviço MEI',
    direction: 'INCOME',
  },
  {
    keywords: ['das ', 'simples nacional', 'darf', 'iptu', 'ipva', 'imposto', 'tributo', 'inss', 'fgts'],
    category: 'Impostos / DAS',
    direction: 'EXPENSE',
  },
  {
    keywords: [
      'supermercado',
      'mercado',
      'padaria',
      'ifood',
      'rappi',
      'restaurante',
      'lanchonete',
      'acougue',
      'hortifruti',
      'cafe',
    ],
    category: 'Alimentação',
    direction: 'EXPENSE',
  },
  {
    keywords: ['uber', '99app', '99pop', 'posto', 'combustivel', 'gasolina', 'etanol', 'estacionamento', 'pedagio', 'sem parar'],
    category: 'Transporte',
    direction: 'EXPENSE',
  },
  {
    keywords: ['aluguel', 'condominio', 'energia', 'eletrica', 'enel', 'cpfl', 'sabesp', 'agua', 'internet', 'vivo', 'claro', 'tim'],
    category: 'Moradia',
    direction: 'EXPENSE',
  },
  {
    keywords: ['fatura', 'cartao', 'anuidade', 'mastercard', 'visa'],
    category: 'Cartão',
    direction: 'EXPENSE',
  },
  {
    keywords: ['papelaria', 'grafica', 'insumo', 'material', 'embalagem', 'fornecedor', 'frete', 'correios'],
    category: 'Insumos / Produção',
    direction: 'EXPENSE',
  },
];

export function categorizeTransactionDescription(params: {
  description: string;
  direction: Direction;
  customRules?: CategoryRule[];
  fallbackCategory?: string;
  cardId?: string;
}): {
  category: string;
  profile?: 'CPF' | 'CNPJ';
  matchedRuleKeyword?: string;
  isCustomRule?: boolean;
} {
  const normDesc = normalizeDescription(params.description || '');
  const fallback = params.fallbackCategory || 'Outros';

  if (!normDesc) {
    return { category: fallback };
  }

  // 1. Custom user / classification_rules take precedence (card-specific & longest keyword first)
  const sortedRules = [...(params.customRules ?? [])].sort((a, b) => {
    const aCardMatch = params.cardId && a.card_id === params.cardId ? 1 : 0;
    const bCardMatch = params.cardId && b.card_id === params.cardId ? 1 : 0;
    if (aCardMatch !== bCardMatch) return bCardMatch - aCardMatch;
    return (b.keyword || '').trim().length - (a.keyword || '').trim().length;
  });

  for (const rule of sortedRules) {
    if (rule.direction && rule.direction !== params.direction) continue;
    if (rule.card_id && params.cardId && rule.card_id !== params.cardId) continue;
    const kw = normalizeDescription(rule.keyword);
    if (kw && normDesc.includes(kw)) {
      const resolvedProfile =
        rule.profile === 'CPF' || rule.profile === 'CNPJ'
          ? rule.profile
          : rule.entityId === 'CPF' || rule.entityId === 'CNPJ'
            ? rule.entityId
            : undefined;
      return {
        category: rule.category || rule.category_id || fallback,
        ...(resolvedProfile ? { profile: resolvedProfile } : {}),
        matchedRuleKeyword: rule.keyword,
        isCustomRule: true,
      };
    }
  }

  // 2. Built-in Portuguese rules
  for (const rule of BUILTIN_RULES) {
    if (rule.direction && rule.direction !== params.direction) continue;
    const matched = rule.keywords.find((kw) => normDesc.includes(kw));
    if (matched) {
      return {
        category: rule.category,
        matchedRuleKeyword: matched,
        isCustomRule: false,
      };
    }
  }

  return { category: fallback };
}
