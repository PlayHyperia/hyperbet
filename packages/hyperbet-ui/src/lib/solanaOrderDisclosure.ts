import type { UiLocale } from "../i18n";

const ENGLISH_CANCELLATION_REFUND_DISCLOSURE =
  "If the duel is cancelled, matched collateral and escrowed execution fees are refundable through claim. Cancellation or reclaim separately returns unmatched collateral and the maker-funded Order account rent to the original maker; shared PriceLevel rent is excluded.";

const CHINESE_CANCELLATION_REFUND_DISCLOSURE =
  "若决斗被取消，已成交抵押和托管的成交手续费可通过领取退回。取消或收回挂单会另行退回未成交抵押，以及由挂单者支付的订单账户租金；共享价格档账户租金不包含在内。";

export function getSolanaCancellationRefundDisclosure(
  locale: UiLocale,
): string {
  return locale === "zh"
    ? CHINESE_CANCELLATION_REFUND_DISCLOSURE
    : ENGLISH_CANCELLATION_REFUND_DISCLOSURE;
}
