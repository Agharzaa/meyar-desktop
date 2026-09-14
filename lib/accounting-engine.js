'use strict';

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;
const roundQuantity = value => Math.round((Number(value) || 0) * 1e6) / 1e6;

function normalizeText(value = '') {
  return String(value)
    .trim()
    .toLocaleLowerCase('az-AZ')
    .replace(/ə/g, 'e')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ğ/g, 'g')
    .replace(/ç/g, 'c')
    .replace(/ş/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferItemType({ itemType = '', description = '', counterpartyName = '', invoiceTypeName = '' } = {}) {
  if (itemType === 'Mal' || itemType === 'Xidmət') return itemType;
  const text = normalizeText(`${description} ${counterpartyName} ${invoiceTypeName}`);
  const serviceTerms = [
    'xidmet', 'rabitə', 'rabite', 'internet', 'telefon', 'mobil', 'abune',
    'icarə', 'icare', 'dasima', 'neqliyyat', 'temir', 'audit', 'konsaltinq',
    'reklam', 'sigorta', 'komissiya', 'ekspedisiya', 'proqram', 'hosting'
  ];
  const goodsTerms = [
    'mal', 'material', 'ehtiyat', 'mehsul', 'avadanliq', 'yanacaq', 'benzin',
    'dizel', 'qablasdirma', 'hisse', 'detal', 'ofis levazimati'
  ];
  const serviceScore = serviceTerms.reduce((score, term) => score + (text.includes(normalizeText(term)) ? 1 : 0), 0);
  const goodsScore = goodsTerms.reduce((score, term) => score + (text.includes(normalizeText(term)) ? 1 : 0), 0);
  if (serviceScore > goodsScore) return 'Xidmət';
  if (goodsScore > serviceScore) return 'Mal';
  return '';
}

function ruleMatches(rule, context) {
  if (!rule || Number(rule.active) !== 1) return false;
  if (rule.direction && rule.direction !== context.direction) return false;
  if (rule.item_type && rule.item_type !== context.itemType) return false;
  const needle = normalizeText(rule.match_value);
  if (!needle) return true;
  const fields = {
    counterparty: context.counterpartyName,
    description: context.description,
    item_code: context.itemCode,
    all: `${context.counterpartyName} ${context.description} ${context.itemCode}`
  };
  return normalizeText(fields[rule.match_field] ?? fields.all).includes(needle);
}

function resolvePosting(context = {}, rules = []) {
  const inferredItemType = inferItemType(context);
  const orderedRules = [...rules]
    .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100) || Number(left.id || 0) - Number(right.id || 0));
  const classificationRule = inferredItemType ? null : orderedRules.find(rule => {
    if (!['Mal','Xidmət'].includes(rule?.item_type) || !normalizeText(rule?.match_value)) return false;
    return ruleMatches(rule, { ...context, itemType: rule.item_type });
  });
  const itemType = inferredItemType || classificationRule?.item_type || context.defaultItemType || 'Xidmət';
  const normalizedContext = { ...context, itemType };
  const matchedRule = orderedRules.find(rule => ruleMatches(rule, normalizedContext));

  const catalogAccount = context.direction === 'Gələn'
    ? context.catalogPurchaseAccount
    : context.catalogSalesAccount;
  const classifiedAccount = inferredItemType && context.direction === 'Gələn'
    ? (itemType === 'Mal' ? context.inventoryAccount : context.expenseAccount)
    : (inferredItemType || classificationRule) ? (context.direction === 'Gələn'
      ? (itemType === 'Mal' ? context.inventoryAccount : context.expenseAccount)
      : (itemType === 'Mal' ? context.goodsSalesAccount : context.serviceSalesAccount)) : '';
  const resolvedAccount = context.explicitAccount || matchedRule?.account_code || catalogAccount || classifiedAccount;
  const accountCode = String(resolvedAccount || context.suspenseAccount || '721.99').trim();
  const automaticFallback = !context.explicitAccount && !catalogAccount && !matchedRule;
  let subkontoId = context.explicitSubkontoId || matchedRule?.subkonto_id || null;
  if (!subkontoId && context.direction === 'Gələn' && itemType === 'Xidmət') {
    subkontoId = accountCode === String(context.expenseAccount || '').trim()
      ? context.defaultExpenseSubkontoId || null
      : accountCode === String(context.suspenseAccount || '').trim()
        ? context.unclassifiedExpenseSubkontoId || null
        : null;
  }

  return {
    itemType,
    accountCode,
    subkontoId,
    warehouseId: context.explicitWarehouseId || matchedRule?.warehouse_id || context.defaultWarehouseId || null,
    matchedRuleId: matchedRule?.id || null,
    confidence: context.explicitAccount || catalogAccount ? 'high' : matchedRule ? 'rule' : classificationRule ? 'classification-rule' : resolvedAccount ? 'semantic-default' : 'suspense',
    needsReview: automaticFallback && (!inferredItemType || !resolvedAccount)
  };
}

function valueInventoryMovements(movements = [], method = 'AVERAGE', standardCost = 0) {
  const valuationMethod = method === 'FIFO' ? 'FIFO' : 'AVERAGE';
  const valued = [];
  const layers = [];
  let quantityOnHand = 0;
  let inventoryValue = 0;
  let lastKnownCost = roundMoney(standardCost);

  for (const movement of movements) {
    const quantity = roundQuantity(Math.abs(Number(movement.quantity) || 0));
    if (quantity <= 0) continue;
    if (movement.direction === 'IN') {
      const totalCost = roundMoney(movement.totalCost ?? quantity * Number(movement.unitCost || 0));
      const unitCost = quantity ? roundMoney(totalCost / quantity) : 0;
      lastKnownCost = unitCost || lastKnownCost;
      quantityOnHand = roundQuantity(quantityOnHand + quantity);
      inventoryValue = roundMoney(inventoryValue + totalCost);
      if (valuationMethod === 'FIFO') layers.push({ quantity, unitCost });
      valued.push({ ...movement, quantity, unitCost, totalCost, shortageQuantity: 0, quantityOnHand, inventoryValue });
      continue;
    }

    let remaining = quantity;
    let totalCost = 0;
    let availableQuantity = Math.max(0, quantityOnHand);
    if (valuationMethod === 'FIFO') {
      while (remaining > 0.0000005 && layers.length) {
        const layer = layers[0];
        const used = Math.min(remaining, layer.quantity);
        totalCost += used * layer.unitCost;
        layer.quantity = roundQuantity(layer.quantity - used);
        remaining = roundQuantity(remaining - used);
        if (layer.quantity <= 0.0000005) layers.shift();
      }
    } else {
      const averageCost = quantityOnHand > 0 ? inventoryValue / quantityOnHand : lastKnownCost;
      const valuedQuantity = Math.min(quantity, availableQuantity);
      totalCost = valuedQuantity * averageCost;
      remaining = roundQuantity(quantity - valuedQuantity);
      lastKnownCost = roundMoney(averageCost) || lastKnownCost;
    }

    const shortageQuantity = roundQuantity(Math.max(0, remaining));
    if (shortageQuantity > 0) totalCost += shortageQuantity * lastKnownCost;
    totalCost = roundMoney(totalCost);
    const unitCost = quantity ? roundMoney(totalCost / quantity) : 0;
    quantityOnHand = roundQuantity(quantityOnHand - quantity);
    inventoryValue = roundMoney(inventoryValue - totalCost);
    valued.push({ ...movement, quantity, unitCost, totalCost, shortageQuantity, quantityOnHand, inventoryValue });
  }

  return { method: valuationMethod, movements: valued, quantityOnHand, inventoryValue, lastKnownCost };
}

module.exports = {
  inferItemType,
  normalizeText,
  resolvePosting,
  roundMoney,
  roundQuantity,
  valueInventoryMovements
};
