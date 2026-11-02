import { useI18n } from '../i18n';
import { quotaPlanLabel, quotaPlanTier } from '../services/quotaLayout';
import type { QuotaDisplayProvider } from '../services/quotaService';
import './PlanChip.css';

/** A credential's plan as a small tinted chip; the tint follows the plan's monthly price (quotaPlanTier) and the theme's planBadge colours. */
export function PlanChip({ provider, plan }: { provider: QuotaDisplayProvider | null | undefined; plan: string }) {
  const { t } = useI18n();
  return <strong className="plan-chip" data-tier={quotaPlanTier(provider, plan)} title={`${t('quota.planLabel')}: ${plan}`}>{quotaPlanLabel(provider, plan)}</strong>;
}
