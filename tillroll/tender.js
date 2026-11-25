// P4 payment method (采购商品方法). Shared by the server review loop and every
// client export path. Card schemes and wallets map to Card with no fill. Cash
// and an empty tender stay as printed or empty and are Pink.
// Apply this BEFORE digit masking; masking is only the backstop so no card
// digits are ever written.
export const ALLOWED_TENDERS = ['UnionPay', 'Card', 'Alipay', 'WeChat'];
export const TENDER_REASON = 'Payment method must be UnionPay, Card, Alipay or WeChat.';
const SCHEME = /\b(visa|mastercard|master\s*card|maestro|amex|american express|debit|credit|card)\b/i;
const WALLET = /\b(apple\s*pay|google\s*pay|samsung\s*pay|garmin\s*pay|android\s*pay|wallet)\b/i;
const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();

export function normaliseTender(p) {
  const s = str(p);
  if (!s) return null;
  if (/union\s*pay/i.test(s)) return 'UnionPay';
  if (/ali\s*pay/i.test(s)) return 'Alipay';
  if (/we\s*chat|wechat/i.test(s)) return 'WeChat';
  if (SCHEME.test(s) || WALLET.test(s)) return 'Card';
  return s;
}

export function tenderIsAllowed(tender) {
  return Boolean(tender) && ALLOWED_TENDERS.includes(tender);
}
